import React, { useState, useEffect } from 'react';
import AdminLayout from '../../components/admin/AdminLayout.jsx';
import AdminSettingsTabs from '../../components/admin/AdminSettingsTabs.jsx';
import { useAdminSession } from '../../context/AdminSessionContext.jsx';
import {
  getOperators,
  createOperator,
  updateOperatorRole,
  updateOperatorStatus,
  deleteOperator,
} from '../../services/adminUserService.js';

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

  // New user form state
  const [newUserName, setNewUserName] = useState('');
  const [newUserEmail, setNewUserEmail] = useState('');
  const [newUserRole, setNewUserRole] = useState('handler');

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

  const handleAddHandler = async (e) => {
    e.preventDefault();
    if (!newUserName.trim() || !newUserEmail.trim()) return;
    setSaving(true);
    try {
      const result = await createOperator({
        name: newUserName.trim(),
        email: newUserEmail.trim(),
        role: newUserRole,
      });
      setNewUserName('');
      setNewUserEmail('');
      setShowAddModal(false);
      await loadUsers();
      triggerToast(`Operator "${result.operator.name}" created successfully.`);
    } catch (err) {
      triggerToast(err.message || 'Could not create operator.');
    } finally {
      setSaving(false);
    }
  };

  const handleRoleChange = async (userId, newRole, userName) => {
    try {
      await updateOperatorRole(userId, newRole);
      await loadUsers();
      triggerToast(`Updated ${userName} role to ${newRole}.`);
    } catch (err) {
      triggerToast(err.message || 'Could not update role.');
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
              <div className="flex items-center gap-1.5 text-[13px] text-[var(--color-botanical-subtle)]">
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
              <h2 className="font-serif text-2xl text-[var(--color-botanical-primary)] font-medium">Operator Directory</h2>
              <p className="text-[13px] text-[var(--color-botanical-muted)] mt-0.5">All operators stored in the database.</p>
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
                + Add Operator
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
                className="w-full pl-9 pr-3 py-1.5 rounded-full bg-[var(--color-surface-lowest)] text-[var(--color-botanical-text)] text-[13px] placeholder:text-[var(--color-botanical-subtle)] focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)] shadow-xs"
              />
            </div>
            <div className="flex items-center gap-1.5 bg-[var(--color-surface-lowest)] px-3 py-1.5 rounded-full shadow-xs text-[13px]">
              <span className="text-[var(--color-botanical-subtle)] text-[11px] font-bold uppercase">Role:</span>
              <select
                value={roleFilter}
                onChange={(e) => setRoleFilter(e.target.value)}
                className="bg-transparent font-semibold text-[var(--color-botanical-text)] focus:outline-none cursor-pointer text-[13px]"
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
              <table className="w-full text-left text-[13px]">
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
                        <td className="py-3.5 px-4 text-right">
                          <div className="inline-flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => handleRoleChange(
                                u.id,
                                u.role === 'ADMINISTRATOR' ? 'handler' : 'admin',
                                u.name
                              )}
                              className="p-1 rounded hover:bg-[var(--color-surface-high)] text-[var(--color-botanical-subtle)] hover:text-[var(--color-botanical-primary)] transition-colors"
                              title={u.role === 'ADMINISTRATOR' ? 'Demote to Handler' : 'Promote to Admin'}
                            >
                              <span className="material-symbols-outlined text-[18px]">swap_horiz</span>
                            </button>
                            {u.id !== currentUserId && (
                              <button
                                type="button"
                                onClick={() => handleStatusChange(u.id, u.status === 'SUSPENDED' ? 'ACTIVE' : 'SUSPENDED', u.name)}
                                className="p-1 rounded hover:bg-[var(--color-surface-high)] text-[var(--color-botanical-subtle)] hover:text-[var(--color-botanical-primary)] transition-colors"
                                title={u.status === 'SUSPENDED' ? 'Reactivate Operator' : 'Suspend Operator'}
                              >
                                <span className="material-symbols-outlined text-[18px]">{u.status === 'SUSPENDED' ? 'play_circle' : 'pause_circle'}</span>
                              </button>
                            )}
                            {!u.isFixture && (
                              <button
                                type="button"
                                onClick={() => handleDelete(u.id, u.name)}
                                className="p-1 rounded hover:bg-[var(--color-surface-high)] text-[var(--color-botanical-subtle)] hover:text-[var(--color-danger)] transition-colors"
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
                Showing {filteredUsers.length} of {users.length} operators
              </div>
            </div>
          )}
        </div>

        {/* Scope & Permission Matrix */}
        <div className="bg-[var(--color-surface-lowest)] rounded-2xl shadow-[0_4px_20px_-2px_rgba(46,36,30,0.04)] border border-[var(--color-botanical-border)] p-6 sm:p-8">
          <h2 className="font-serif text-2xl text-[var(--color-botanical-primary)] font-medium mb-4">Role Permission Matrix</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="text-[var(--color-botanical-subtle)] text-[11px] font-bold uppercase tracking-wider bg-[var(--color-surface-low)]/60">
                  <th className="py-3 px-4 rounded-l-lg">Module</th>
                  <th className="py-3 px-4">Administrator</th>
                  <th className="py-3 px-4 rounded-r-lg">Handler</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-divider)]">
                {[
                  ['Dashboard', 'Full Access', 'View Only'],
                  ['Orders', 'Full Access', 'Manage & Process'],
                  ['Products & Collections', 'Full Access', 'Manage Catalog'],
                  ['Inventory', 'Full Access', 'Manage & Adjust'],
                  ['Customers', 'Full Access', 'View & Support'],
                  ['Analytics', 'Full Access', 'View Only'],
                  ['Settings', 'Full Access', 'No Access'],
                  ['Operator Management', 'Full Access', 'No Access'],
                ].map(([module, admin, handler]) => (
                  <tr key={module} className="hover:bg-[var(--color-surface-low)]/40 transition-colors">
                    <td className="py-3 px-4 font-semibold text-[var(--color-botanical-primary)]">{module}</td>
                    <td className="py-3 px-4 text-[#1d2918]">{admin}</td>
                    <td className="py-3 px-4 text-[var(--color-botanical-muted)]">{handler}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Add Operator Modal */}
        {showAddModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs">
            <div className="bg-[var(--color-surface-lowest)] rounded-2xl max-w-md w-full p-6 shadow-2xl border border-[var(--color-botanical-border)] animate-fade-in space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-[var(--color-botanical-primary)]">
                  <span className="material-symbols-outlined text-[22px] text-[var(--color-accent)]">person_add</span>
                  <h3 className="font-serif text-xl font-medium">Add Operator</h3>
                </div>
                <button type="button" onClick={() => setShowAddModal(false)} className="p-1 rounded-lg text-[var(--color-botanical-subtle)] hover:bg-[var(--color-surface-container)]">
                  <span className="material-symbols-outlined text-[20px]">close</span>
                </button>
              </div>
              <form onSubmit={handleAddHandler} className="space-y-4 text-[13px]">
                <div>
                  <label className="block text-[11px] font-bold uppercase text-[var(--color-botanical-subtle)] mb-1">Full Name</label>
                  <input
                    type="text"
                    required
                    value={newUserName}
                    onChange={(e) => setNewUserName(e.target.value)}
                    placeholder="e.g. Meera Nambiar"
                    className="w-full px-3 py-2 bg-[var(--color-surface-low)] rounded-xl border border-transparent focus:border-[var(--color-focus)] focus:bg-[var(--color-surface-lowest)] focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-bold uppercase text-[var(--color-botanical-subtle)] mb-1">Email</label>
                  <input
                    type="email"
                    required
                    value={newUserEmail}
                    onChange={(e) => setNewUserEmail(e.target.value)}
                    placeholder="e.g. meera@flora-alchemy.com"
                    className="w-full px-3 py-2 bg-[var(--color-surface-low)] rounded-xl border border-transparent focus:border-[var(--color-focus)] focus:bg-[var(--color-surface-lowest)] focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-bold uppercase text-[var(--color-botanical-subtle)] mb-1">Role</label>
                  <select
                    value={newUserRole}
                    onChange={(e) => setNewUserRole(e.target.value)}
                    className="w-full px-3 py-2 bg-[var(--color-surface-low)] rounded-xl border border-transparent focus:border-[var(--color-focus)] focus:bg-[var(--color-surface-lowest)] focus:outline-none cursor-pointer"
                  >
                    <option value="handler">Handler (Catalog & Packaging)</option>
                    <option value="admin">Administrator (Full Access)</option>
                  </select>
                </div>
                <p className="text-[12px] text-[var(--color-botanical-subtle)]">
                  A temporary password will be generated. The operator must change it on first login.
                </p>
                <div className="pt-3 flex items-center justify-end gap-2">
                  <button type="button" onClick={() => setShowAddModal(false)} className="px-4 py-2 rounded-full text-[var(--color-botanical-muted)] hover:bg-[var(--color-surface-low)] font-semibold">Cancel</button>
                  <button
                    type="submit"
                    disabled={saving}
                    className="px-5 py-2 rounded-full bg-[var(--color-btn)] text-white hover:bg-[var(--color-btn-hover-alt)] font-semibold shadow-xs disabled:opacity-50"
                  >
                    {saving ? 'Creating...' : 'Create Operator'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Toast */}
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
