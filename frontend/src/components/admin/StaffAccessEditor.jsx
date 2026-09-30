import React, { useEffect, useMemo, useState } from 'react';
import { AdminModal, StaffButton } from './StaffPrimitives.jsx';
import {
  getAccessCatalogue,
  getStaffAccess,
  updateStaffAccess,
} from '../../services/staffAccessService.js';

/**
 * StaffAccessEditor — the Admin "Access & Role" panel for one staff member.
 *
 * ROLE = PERMISSION BUNDLE · PERMISSIONS = ACTUAL AUTHORITY.
 *
 * Choosing a role template loads that bundle; ticking or unticking anything
 * turns the selection into a Custom Role with exactly the boxes that are set.
 * "Select all workspace operations" is the Full Workspace Access bundle — the
 * catalogue comes from the SERVER and contains no owner, administrator,
 * platform or ownership permission at all, so this panel cannot offer authority
 * the middleware would refuse.
 *
 * Nothing here is enforcement: the server re-derives the same list from the
 * database on every gated request. This is the editor for it.
 */
export default function StaffAccessEditor({ open, staff, onClose, onSaved }) {
  const [catalogue, setCatalogue] = useState(null);
  const [reserved, setReserved] = useState([]);
  const [role, setRole] = useState('custom');
  const [selected, setSelected] = useState(() => new Set());
  const [effectiveCount, setEffectiveCount] = useState(0);
  const [legacyDefault, setLegacyDefault] = useState(false);
  const [state, setState] = useState('loading'); // loading | ready | error
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState('');

  useEffect(() => {
    if (!open || !staff?.id) return undefined;
    let live = true;
    setState('loading');
    setError('');
    setSaved('');
    (async () => {
      const [cat, access] = await Promise.all([
        getAccessCatalogue(),
        getStaffAccess(staff.id),
      ]);
      if (!live) return;
      if (!cat.ok || !access.ok) {
        setState('error');
        setError(cat.message || access.message || 'Could not load access settings.');
        return;
      }
      setCatalogue(cat.catalogue);
      setReserved(cat.reserved || []);
      const view = access.access || {};
      setRole(view.role || 'custom');
      setSelected(new Set(view.effective || []));
      setEffectiveCount((view.effective || []).length);
      setLegacyDefault(!!view.legacyDefault);
      setState('ready');
    })();
    return () => {
      live = false;
    };
  }, [open, staff?.id]);

  const templates = catalogue?.templates || [];
  const groups = catalogue?.groups || [];
  const fullAccess = catalogue?.fullAccess || [];
  const total = catalogue?.total || 0;

  const allSelected = useMemo(
    () => fullAccess.length > 0 && fullAccess.every((p) => selected.has(p)),
    [fullAccess, selected]
  );

  const applyTemplate = (key) => {
    setRole(key);
    const tpl = templates.find((t) => t.key === key);
    if (tpl) setSelected(new Set(tpl.permissions));
  };

  const toggle = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setRole('custom');
  };

  const toggleGroup = (group, on) => {
    setSelected((prev) => {
      const next = new Set(prev);
      group.permissions.forEach((p) => (on ? next.add(p.id) : next.delete(p.id)));
      return next;
    });
    setRole('custom');
  };

  const selectAllWorkspaceOperations = () => {
    setSelected(new Set(fullAccess));
    setRole('full_workspace');
  };

  const clearAll = () => {
    setSelected(new Set());
    setRole('custom');
  };

  const save = async () => {
    setSaving(true);
    setError('');
    const res = await updateStaffAccess(staff.id, {
      role,
      permissions: [...selected],
    });
    setSaving(false);
    if (!res.ok) {
      setError(res.message || 'Could not save access.');
      return;
    }
    setRole(res.access?.role || role);
    setSelected(new Set(res.access?.effective || []));
    setEffectiveCount((res.access?.effective || []).length);
    setLegacyDefault(!!res.access?.legacyDefault);
    setSaved(
      res.changed && (res.changed.granted.length || res.changed.removed.length)
        ? `Saved · granted ${res.changed.granted.length}, removed ${res.changed.removed.length}`
        : 'Saved'
    );
    onSaved?.(res);
  };

  return (
    <AdminModal open={open} onClose={onClose} labelledBy="staff-access-title">
      <div className="space-y-4 max-h-[85vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-botanical-subtle)]">
              Access &amp; Role
            </p>
            <h3
              id="staff-access-title"
              className="font-serif text-xl text-[var(--color-botanical-primary)] dark:text-[#f7f4ef] truncate"
            >
              {staff?.name || staff?.email || 'Staff member'}
            </h3>
            <p className="text-[12px] text-[var(--color-botanical-muted)] truncate">{staff?.email}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close access editor"
            className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg text-[var(--color-botanical-subtle)] hover:bg-[var(--color-surface-container)]"
          >
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>

        {state === 'loading' && (
          <div className="py-10 flex items-center justify-center">
            <span className="material-symbols-outlined text-[22px] animate-spin text-[var(--color-accent)]">
              progress_activity
            </span>
          </div>
        )}

        {state === 'error' && (
          <div className="rounded-xl bg-[var(--color-danger-soft-bg)] p-4 text-[13px] text-[var(--color-danger-soft-fg)]">
            {error}
          </div>
        )}

        {state === 'ready' && (
          <>
            <div>
              <label
                htmlFor="staff-access-role"
                className="block text-[11px] font-bold uppercase text-[var(--color-botanical-subtle)] mb-1"
              >
                Role / Access Template
              </label>
              <select
                id="staff-access-role"
                value={role}
                onChange={(e) => applyTemplate(e.target.value)}
                className="w-full px-3 py-2 min-h-[44px] bg-[var(--color-surface-low)] rounded-xl border border-transparent focus:border-[var(--color-focus)] focus:outline-none cursor-pointer text-[13px] dark:bg-[#2e2a25] dark:text-[#f0ede9]"
              >
                {templates.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.label}
                  </option>
                ))}
              </select>
              <p className="mt-1.5 text-[12px] text-[var(--color-botanical-muted)]">
                {templates.find((t) => t.key === role)?.description ||
                  'Custom role — the checked permissions below are the authority.'}
              </p>
              {legacyDefault && (
                <p className="mt-2 rounded-lg bg-[var(--color-surface-low)] px-3 py-2 text-[12px] text-[var(--color-botanical-muted)] dark:bg-[#2e2a25]">
                  This account predates granular permissions and currently holds Full Workspace
                  Access. Saving below makes the checked set the authority.
                </p>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={selectAllWorkspaceOperations}
                className="min-h-[44px] px-3.5 rounded-full bg-[var(--color-surface-container)] text-[12px] font-semibold text-[var(--color-botanical-text)] hover:bg-[var(--color-surface-high)] dark:bg-[#2e2a25] dark:text-[#f0ede9]"
              >
                Select all workspace operations
              </button>
              <button
                type="button"
                onClick={clearAll}
                className="min-h-[44px] px-3.5 rounded-full bg-transparent text-[12px] font-semibold text-[var(--color-botanical-muted)] hover:bg-[var(--color-surface-container)]"
              >
                Clear
              </button>
              <span className="text-[12px] text-[var(--color-botanical-subtle)] ml-auto">
                {selected.size} of {total} permissions
                {allSelected ? ' · Full Workspace Access' : ''}
              </span>
            </div>

            <div className="space-y-2">
              {groups.map((group) => {
                const ids = group.permissions.map((p) => p.id);
                const checked = ids.filter((id) => selected.has(id)).length;
                return (
                  <details
                    key={group.key}
                    open
                    className="rounded-xl border border-[var(--color-botanical-border)] bg-[var(--color-surface-lowest)] dark:bg-[#1f1c19] dark:border-[#3a3530]"
                  >
                    <summary className="cursor-pointer list-none px-4 py-3 min-h-[44px] flex items-center gap-2 text-[13px] font-semibold text-[var(--color-botanical-primary)] dark:text-[#f7f4ef]">
                      <span className="material-symbols-outlined text-[18px] text-[var(--color-accent)]" aria-hidden="true">
                        {group.icon || 'chevron_right'}
                      </span>
                      <span className="min-w-0 truncate">{group.label}</span>
                      <span className="ml-auto text-[11px] font-bold text-[var(--color-botanical-subtle)]">
                        {checked}/{ids.length}
                      </span>
                    </summary>
                    <div className="px-3 pb-3">
                      <div className="flex items-center justify-end gap-1 pb-1">
                        <button
                          type="button"
                          onClick={() => toggleGroup(group, true)}
                          className="min-h-[44px] px-2 text-[11px] font-bold uppercase tracking-wider text-[var(--color-accent)]"
                        >
                          All
                        </button>
                        <button
                          type="button"
                          onClick={() => toggleGroup(group, false)}
                          className="min-h-[44px] px-2 text-[11px] font-bold uppercase tracking-wider text-[var(--color-botanical-subtle)]"
                        >
                          None
                        </button>
                      </div>
                      {group.permissions.map((p) => (
                        <label
                          key={p.id}
                          htmlFor={`perm-${p.id}`}
                          className="flex items-start gap-3 px-2 py-2 min-h-[44px] rounded-lg hover:bg-[var(--color-surface-low)] cursor-pointer"
                        >
                          <input
                            id={`perm-${p.id}`}
                            type="checkbox"
                            checked={selected.has(p.id)}
                            onChange={() => toggle(p.id)}
                            className="mt-0.5 h-5 w-5 shrink-0 accent-[#964735]"
                          />
                          <span className="min-w-0">
                            <span className="block text-[13px] font-medium text-[var(--color-botanical-text)] dark:text-[#f0ede9]">
                              {p.label}
                            </span>
                            <span className="block text-[12px] text-[var(--color-botanical-muted)]">
                              {p.description}
                            </span>
                          </span>
                        </label>
                      ))}
                    </div>
                  </details>
                );
              })}
            </div>

            <div className="rounded-xl bg-[var(--color-surface-low)] p-3 dark:bg-[#26221e]">
              <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-botanical-subtle)] mb-1">
                Never assignable
              </p>
              <ul className="text-[12px] text-[var(--color-botanical-muted)] space-y-0.5">
                {reserved.map((r) => (
                  <li key={r} className="flex items-start gap-1.5">
                    <span className="material-symbols-outlined text-[14px] text-[var(--color-danger)]" aria-hidden="true">
                      block
                    </span>
                    <span>{r}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[12px] text-[var(--color-botanical-muted)]">
                Effective now: {effectiveCount} permission{effectiveCount === 1 ? '' : 's'}. Changes
                take effect on the staff member’s next request — no re-login required.
              </p>
            </div>

            {error && (
              <div className="rounded-xl bg-[var(--color-danger-soft-bg)] p-3 text-[13px] text-[var(--color-danger-soft-fg)]">
                {error}
              </div>
            )}
            {saved && !error && (
              <div className="rounded-xl bg-[var(--color-botanical-sage-light)] p-3 text-[13px] font-semibold text-[#131f0e]">
                {saved}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
              <StaffButton variant="ghost" onClick={onClose}>
                Close
              </StaffButton>
              <StaffButton onClick={save} loading={saving} icon="save">
                Save Access
              </StaffButton>
            </div>
          </>
        )}
      </div>
    </AdminModal>
  );
}
