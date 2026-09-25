import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import AdminLayout from '../../components/admin/AdminLayout.jsx';
import { useAdminSession } from '../../context/AdminSessionContext.jsx';
import {
  getStaff,
  getStaffMember,
  getStaffActivity,
  suspendStaff,
  reactivateStaff,
  createHandlerInvitation,
  resendInvitation,
  revokeInvitation,
} from '../../services/staffService.js';
import {
  StaffStatusPill,
  StaffRoleBadge,
  StaffAvatar,
  StaffEmptyState,
  StaffTableSkeleton,
  StaffCardSkeleton,
  AdminToast,
  AdminModal,
  MetaField,
  StaffButton,
} from '../../components/admin/StaffPrimitives.jsx';

/**
 * Phase 20.6.4 — My Staff / Staff Directory & Personnel Lifecycle.
 * (design refs: "My Staff", "Add Handler" drawer, "Staff Directory & Personnel
 *  Lifecycle" dossier + suspension modal)
 *
 * One screen, two audiences: an administrator sees their team ("My Staff"), the
 * owner sees the whole roster including administrators ("Staff Directory"). The
 * difference is DATA and PERMISSION, not layout — the backend returns an
 * `actions` object per row saying exactly what this actor may do, and the UI
 * renders only those actions. Nothing is decided client-side.
 *
 * Everything on the page is real: KPI counts and filter chip counts come from
 * the server's roster-wide counts (so they never change meaning when a filter
 * is applied), the table is the merged account + invitation roster, the dossier
 * is one record, and the timeline contains only events that were actually
 * recorded (an account with no history shows a real empty state).
 *
 * Data policy: staff mutations refresh ONLY the affected record and the list —
 * no global store rehydration, no duplicate hydration, no bootstrap blocking.
 */

const DEPARTMENTS = [
  'Packaging & Keepsake Boxes',
  'Floral Sculpting & Pipe Craft',
  'Letterpress & Deckled Stationery',
  'Petal Dyeing & Wire Binding',
  'Logistics & Courier Fulfillment',
  'Botanical Quality Assurance',
];

const SUSPENSION_REASONS = [
  'Policy & Quality Audit Review',
  'Approved Temporary Sabbatical / Leave',
  'Department Transfer in Transit',
  'Workbench Re-calibration Required',
  'Security Review',
];

const EMPTY_FORM = { name: '', email: '', phone: '', department: DEPARTMENTS[0], notes: '' };

/** Deterministic avatar tone so the same person keeps the same colour. */
function toneFor(id) {
  const tones = ['primary', 'accent', 'sage', 'muted'];
  const sum = String(id || '').split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
  return tones[sum % tones.length];
}

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function formatDateTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function countdown(expiresAt) {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (Number.isNaN(ms) || ms <= 0) return 'Expired';
  const mins = Math.floor(ms / 60000);
  const hours = Math.floor(mins / 60);
  return hours <= 0 ? `${mins}m left` : `${hours}h ${mins % 60}m left`;
}

export default function AdminStaffPage() {
  const { session } = useAdminSession();
  // /admin/staff/:staffId deep-links straight to one dossier, so a colleague
  // can be pointed at a specific record instead of "the person in row 4".
  const { staffId: routeStaffId } = useParams();
  const isOwner = !!session?.isOwner;

  const [rows, setRows] = useState([]);
  const [counts, setCounts] = useState(null);
  const [listState, setListState] = useState('loading'); // loading | ready | error
  const [listError, setListError] = useState('');

  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [roleFilter, setRoleFilter] = useState('ALL');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [sort, setSort] = useState('joined-desc');

  const [selectedId, setSelectedId] = useState(null);
  const [member, setMember] = useState(null);
  const [memberState, setMemberState] = useState('idle');
  const [events, setEvents] = useState([]);
  const [eventsState, setEventsState] = useState('idle');

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState('');
  const [sending, setSending] = useState(false);
  const [issued, setIssued] = useState(null); // { invitation, link }

  const [suspendTarget, setSuspendTarget] = useState(null);
  const [suspendForm, setSuspendForm] = useState({ reason: SUSPENSION_REASONS[0], note: '' });
  const [suspending, setSuspending] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState(null);
  const [revoking, setRevoking] = useState(false);

  const [busyId, setBusyId] = useState(null);
  const [toast, setToast] = useState(null);

  const notify = useCallback((title, message, tone = 'success', action = null) => {
    setToast({ title, message, tone, action, id: Date.now() });
  }, []);

  // Debounce search so typing does not fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  const loadStaff = useCallback(async () => {
    setListState((prev) => (prev === 'ready' ? 'refreshing' : 'loading'));
    const res = await getStaff({
      role: roleFilter,
      status: statusFilter,
      q: debouncedQ,
      sort,
    });
    if (!res.ok) {
      setListState('error');
      setListError(res.message || 'Could not load the staff roster.');
      return;
    }
    setRows(res.staff);
    setCounts(res.counts);
    setListState('ready');
  }, [roleFilter, statusFilter, debouncedQ, sort]);

  useEffect(() => {
    loadStaff();
  }, [loadStaff]);

  const loadMember = useCallback(async (id) => {
    if (!id) return;
    setMemberState('loading');
    setEventsState('loading');
    const [m, a] = await Promise.all([getStaffMember(id), getStaffActivity(id)]);
    if (m.ok) {
      setMember(m.member);
      setMemberState('ready');
    } else {
      setMember(null);
      setMemberState('error');
    }
    if (a.ok) {
      setEvents(a.events);
      setEventsState('ready');
    } else {
      setEvents([]);
      setEventsState('error');
    }
  }, []);

  useEffect(() => {
    if (routeStaffId) setSelectedId(routeStaffId);
  }, [routeStaffId]);

  useEffect(() => {
    if (selectedId) loadMember(selectedId);
  }, [selectedId, loadMember]);

  // ── Actions ──────────────────────────────────────────────────────────────

  const copyLink = async (link) => {
    try {
      await navigator.clipboard.writeText(link);
      notify('Invitation link copied', 'Send it to the handler over a channel you trust.', 'success');
    } catch {
      // Clipboard can be blocked (insecure origin, permissions). Surface the
      // link so the admin can still copy it by hand instead of silently failing.
      notify('Copy blocked by the browser', 'Select the link shown in the panel and copy it manually.', 'info');
    }
  };

  const handleSendInvitation = async (e) => {
    e?.preventDefault?.();
    setFormError('');
    if (form.name.trim().length < 2) {
      setFormError('Please enter the handler’s full name.');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) {
      setFormError('Please enter a valid work email address.');
      return;
    }
    setSending(true);
    const res = await createHandlerInvitation({
      name: form.name.trim(),
      email: form.email.trim(),
      phone: form.phone.trim(),
      department: form.department,
      notes: form.notes.trim(),
    });
    setSending(false);
    if (!res.ok) {
      // Real server verdicts, each with its own next step.
      if (res.code === 'EMAIL_TAKEN') {
        setFormError('A staff account with this email already exists. Manage it from the roster instead.');
      } else if (res.code === 'INVITATION_PENDING') {
        setFormError('An invitation for this email is already pending. Resend it from the Invitations page instead of issuing a second one.');
      } else {
        setFormError(res.message || 'Could not create the invitation.');
      }
      return;
    }
    setIssued({ invitation: res.invitation, link: res.link });
    setForm(EMPTY_FORM);
    notify('Invitation issued', `A one-time activation link for ${res.invitation?.recipientEmail} was created.`, 'success');
    loadStaff();
  };

  const handleResend = async (invitation) => {
    setBusyId(invitation.id);
    const res = await resendInvitation(invitation.id);
    setBusyId(null);
    if (!res.ok) {
      notify('Could not resend the invitation', res.message, 'error');
      return;
    }
    // The response carries the ONLY copy of the new link. Show it immediately.
    setIssued({ invitation: res.invitation, link: res.link });
    notify('Invitation re-sent', 'The previous link no longer works.', 'success');
    loadStaff();
    if (selectedId === invitation.id) loadMember(invitation.id);
  };

  const handleRevoke = async () => {
    if (!revokeTarget) return;
    setRevoking(true);
    const res = await revokeInvitation(revokeTarget.id);
    setRevoking(false);
    if (!res.ok) {
      notify('Could not revoke the invitation', res.message, 'error');
      return;
    }
    notify('Invitation revoked', `The link for ${revokeTarget.email} can no longer be used.`, 'success');
    setRevokeTarget(null);
    if (issued?.invitation?.id === revokeTarget.id) setIssued(null);
    loadStaff();
    if (selectedId === revokeTarget.id) loadMember(revokeTarget.id);
  };

  const handleSuspend = async () => {
    if (!suspendTarget) return;
    setSuspending(true);
    const res = await suspendStaff(suspendTarget.id, {
      reason: suspendForm.reason,
      note: suspendForm.note,
    });
    setSuspending(false);
    if (!res.ok) {
      const friendly =
        res.code === 'SELF_ACTION_FORBIDDEN' ? 'You cannot suspend your own account.'
          : res.code === 'OWNER_REQUIRED' ? 'Only the owner can manage administrator accounts.'
            : res.code === 'LAST_ADMIN' ? 'The last active administrator cannot be suspended.'
              : res.code === 'FIXTURE_READONLY' ? 'Seed fixture accounts are read-only.'
                : res.message;
      notify('Suspension refused', friendly, 'error');
      return;
    }
    notify('Staff member suspended', res.message, 'success');
    setSuspendTarget(null);
    loadStaff();
    if (selectedId === suspendTarget.id) loadMember(suspendTarget.id);
  };

  const handleReactivate = async (row) => {
    setBusyId(row.id);
    const res = await reactivateStaff(row.id);
    setBusyId(null);
    if (!res.ok) {
      notify('Could not reactivate', res.message, 'error');
      return;
    }
    notify('Staff member reactivated', res.message, 'success');
    loadStaff();
    if (selectedId === row.id) loadMember(row.id);
  };

  const chips = useMemo(() => {
    const c = counts || {};
    return [
      { key: 'ALL', label: 'All', count: c.all ?? 0 },
      { key: 'ROLE:admin', label: 'Administrators', count: c.administrators ?? 0 },
      { key: 'ROLE:handler', label: 'Handlers', count: c.handlers ?? 0 },
      { key: 'ACTIVE', label: 'Active', count: c.active ?? 0 },
      { key: 'INVITED', label: 'Invited', count: c.invited ?? 0 },
      { key: 'SUSPENDED', label: 'Suspended', count: c.suspended ?? 0 },
      { key: 'EXPIRED', label: 'Expired', count: c.expired ?? 0 },
    ];
  }, [counts]);

  const activeChipKey =
    roleFilter !== 'ALL' ? `ROLE:${roleFilter === 'ADMINISTRATOR' ? 'admin' : 'handler'}`
      : statusFilter !== 'ALL' ? statusFilter
        : 'ALL';

  const applyChip = (key) => {
    if (key === 'ALL') {
      setRoleFilter('ALL');
      setStatusFilter('ALL');
    } else if (key.startsWith('ROLE:')) {
      setRoleFilter(key.slice(5) === 'admin' ? 'ADMINISTRATOR' : 'HANDLER');
      setStatusFilter('ALL');
    } else {
      setRoleFilter('ALL');
      setStatusFilter(key);
    }
  };

  // Handlers never reach this route (the sidebar hides it and the backend
  // returns 403), but the header copy must still be truthful for both staff
  // audiences that DO reach it.
  const pageTitle = isOwner ? 'Staff Directory' : 'My Staff';
  const pageLede = isOwner
    ? 'Every administrator and handler in the atelier, with the lifecycle actions your ownership grants you.'
    : 'The handlers on your atelier floor, their invitations, and the lifecycle actions you can take.';

  return (
    <AdminLayout>
      <div className="max-w-7xl mx-auto relative">
        {/* Ambient atelier glow — same treatment as the rest of the console */}
        <div className="absolute -top-12 -left-12 w-80 h-80 bg-[var(--color-badge-bg)]/20 rounded-full blur-3xl pointer-events-none -z-10" />

        {/* ── Header ── */}
        <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-5 mb-8">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-accent)]" />
              <span className="text-[11px] font-bold uppercase tracking-widest text-[var(--color-botanical-muted)]">
                {isOwner ? 'Personnel Ledger' : 'Team Architecture'}
              </span>
            </div>
            <h1 className="font-serif text-[34px] sm:text-[40px] leading-tight text-[var(--color-botanical-text)] tracking-tight dark:text-[#f0ede9]">
              {pageTitle}
            </h1>
            <p className="text-[15px] text-[var(--color-botanical-muted)] max-w-2xl mt-1">{pageLede}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <StaffButton icon="person_add" variant="primary" size="lg" onClick={() => { setIssued(null); setForm(EMPTY_FORM); setFormError(''); setDrawerOpen(true); }}>
              Add Handler
            </StaffButton>
          </div>
        </div>

        {/* ── KPI cards (server counts — never recomputed from the filtered page) ── */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          <KpiCard
            label="Total Handlers"
            value={counts?.handlers}
            icon="groups"
            footnote={
              counts?.administrators
                ? `${counts.administrators} administrator${counts.administrators === 1 ? '' : 's'} also on the roster`
                : 'No administrators on the roster'
            }
            tag="ROSTER"
          />
          <KpiCard
            label="Active On Shift"
            value={counts?.active}
            icon="nest_clock_farsight_analog"
            tone="sage"
            footnote="Accounts able to sign in right now"
            tag="LIVE"
            tagTone="sage"
          />
          <KpiCard
            label="Pending Invites"
            value={counts?.invited}
            icon="outgoing_mail"
            tone="accent"
            footnote="Awaiting activation link"
            tag="PENDING"
            tagTone="accent"
          />
          <KpiCard
            label="Suspended"
            value={counts?.suspended}
            icon="lock_clock"
            tone="danger"
            footnote="Access restricted"
            tag="FLAGGED"
            tagTone="danger"
          />
        </div>

        {/* ── Filters + search ── */}
        <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4 mb-5">
          <div className="flex items-center gap-2 overflow-x-auto pb-1 -mx-1 px-1">
            {chips.map((chip) => {
              const active = activeChipKey === chip.key;
              return (
                <button
                  key={chip.key}
                  type="button"
                  onClick={() => applyChip(chip.key)}
                  className={`px-3.5 py-1.5 rounded-full text-[11px] font-bold uppercase tracking-wider whitespace-nowrap transition-colors ${
                    active
                      ? 'bg-[var(--color-btn)] text-white shadow-sm dark:bg-[#964735]'
                      : 'bg-[var(--color-surface-lowest)] text-[var(--color-botanical-muted)] hover:text-[var(--color-botanical-text)] shadow-sm dark:bg-[#26221e] dark:text-[#b8b0a8]'
                  }`}
                >
                  {chip.label}
                  <span className="ml-1.5 opacity-70 font-normal">{chip.count}</span>
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-2">
            <div className="relative flex-1 xl:w-80">
              <span className="material-symbols-outlined absolute left-3.5 top-1/2 -translate-y-1/2 text-[18px] text-[var(--color-botanical-subtle)]">
                search
              </span>
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Filter by name, ID, email or department…"
                aria-label="Search staff"
                className="w-full pl-10 pr-4 py-2.5 rounded-full bg-[var(--color-surface-lowest)] text-[13px] text-[var(--color-botanical-text)] placeholder:text-[var(--color-botanical-subtle)] shadow-sm outline-none focus:ring-2 focus:ring-[var(--color-focus)] dark:bg-[#1f1c19] dark:text-[#f0ede9]"
              />
            </div>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value)}
              aria-label="Sort staff"
              className="px-3 py-2.5 rounded-full bg-[var(--color-surface-lowest)] text-[12px] font-semibold text-[var(--color-botanical-text)] shadow-sm outline-none focus:ring-2 focus:ring-[var(--color-focus)] cursor-pointer dark:bg-[#1f1c19] dark:text-[#f0ede9]"
            >
              <option value="joined-desc">Newest joined</option>
              <option value="joined-asc">Oldest joined</option>
              <option value="name-asc">Name A–Z</option>
              <option value="name-desc">Name Z–A</option>
              <option value="activity-desc">Most recently active</option>
            </select>
          </div>
        </div>

        {/* ── Roster + dossier ── */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <div className="lg:col-span-7">
            <div className="rounded-2xl bg-[var(--color-surface-lowest)] shadow-[0_4px_20px_-2px_rgba(46,36,30,0.05)] overflow-hidden dark:bg-[#1f1c19]">
              <div className="px-5 py-3.5 bg-[var(--color-surface-low)] flex items-center justify-between dark:bg-[#26221e]">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-[18px] text-[var(--color-accent)]">account_tree</span>
                  <span className="font-serif text-[17px] text-[var(--color-botanical-text)] dark:text-[#f0ede9]">
                    Personnel Roster
                  </span>
                </div>
                <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-botanical-subtle)]">
                  {listState === 'ready' || listState === 'refreshing'
                    ? `${rows.length} shown of ${counts?.all ?? rows.length}`
                    : 'Loading…'}
                </span>
              </div>

              {listState === 'loading' && <StaffTableSkeleton rows={6} />}

              {listState === 'error' && (
                <StaffEmptyState
                  icon="cloud_off"
                  title="Could not load the roster"
                  description={listError}
                  action={<StaffButton icon="refresh" onClick={loadStaff}>Try again</StaffButton>}
                />
              )}

              {listState !== 'loading' && listState !== 'error' && rows.length === 0 && (
                <StaffEmptyState
                  icon="group_off"
                  title={debouncedQ || statusFilter !== 'ALL' || roleFilter !== 'ALL' ? 'No staff match these filters' : 'No staff yet'}
                  description={
                    debouncedQ || statusFilter !== 'ALL' || roleFilter !== 'ALL'
                      ? 'Clear the search or choose a different filter to see the rest of the roster.'
                      : 'Invite your first handler and they will appear here as soon as the invitation is issued.'
                  }
                  action={
                    debouncedQ || statusFilter !== 'ALL' || roleFilter !== 'ALL' ? (
                      <StaffButton
                        icon="filter_alt_off"
                        variant="secondary"
                        onClick={() => { setQ(''); setRoleFilter('ALL'); setStatusFilter('ALL'); }}
                      >
                        Clear filters
                      </StaffButton>
                    ) : (
                      <StaffButton icon="person_add" onClick={() => setDrawerOpen(true)}>Add Handler</StaffButton>
                    )
                  }
                />
              )}

              {listState !== 'loading' && listState !== 'error' && rows.length > 0 && (
                <>
                  {/* Desktop table — horizontal scroll is bounded by the card. */}
                  <div className="hidden md:block overflow-x-auto">
                    <table className="w-full text-left border-collapse min-w-[720px]">
                      <thead>
                        <tr className="bg-[var(--color-surface-container)]/60 text-[10px] font-bold uppercase tracking-wider text-[var(--color-botanical-muted)]">
                          <th className="py-3 px-5">Staff Member</th>
                          <th className="py-3 px-3">Role</th>
                          <th className="py-3 px-3">Department</th>
                          <th className="py-3 px-3">Status</th>
                          <th className="py-3 px-3">Joined</th>
                          <th className="py-3 px-3">Activity</th>
                          <th className="py-3 px-5 text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((row) => (
                          <Row
                            key={`${row.kind}-${row.id}`}
                            row={row}
                            selected={selectedId === row.id}
                            busy={busyId === row.id}
                            onSelect={() => setSelectedId(row.id)}
                            onResend={() => handleResend(row)}
                            onRevoke={() => setRevokeTarget(row)}
                            onReactivate={() => handleReactivate(row)}
                          />
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* Mobile cards — the same data, never a shrunken table. */}
                  <div className="md:hidden divide-y divide-[var(--color-divider)]">
                    {rows.map((row) => (
                      <button
                        key={`${row.kind}-${row.id}`}
                        type="button"
                        onClick={() => setSelectedId(row.id)}
                        className="w-full text-left px-4 py-4 hover:bg-[var(--color-surface-low)] transition-colors"
                      >
                        <div className="flex items-start gap-3">
                          <StaffAvatar
                            initials={row.initials}
                            tone={row.status === 'SUSPENDED' ? 'danger' : toneFor(row.id)}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-semibold text-[14px] text-[var(--color-botanical-text)] truncate dark:text-[#f0ede9]">
                                {row.name}
                              </span>
                              <StaffRoleBadge roleBadge={row.roleBadge} />
                            </div>
                            <p className="text-[12px] text-[var(--color-botanical-muted)] truncate mt-0.5">{row.email}</p>
                            <div className="flex items-center gap-2 mt-2 flex-wrap">
                              <StaffStatusPill status={row.status} />
                              <span className="text-[11px] font-mono text-[var(--color-botanical-subtle)]">{row.staffId}</span>
                            </div>
                          </div>
                          <span className="material-symbols-outlined text-[18px] text-[var(--color-botanical-subtle)]">chevron_right</span>
                        </div>
                      </button>
                    ))}
                  </div>
                </>
              )}

              <div className="px-5 py-2.5 bg-[var(--color-surface-low)] flex items-center justify-between text-[11px] text-[var(--color-botanical-subtle)] dark:bg-[#26221e]">
                <span className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-botanical-sage)]" />
                  Lifecycle changes apply to the next request — no sign-out needed
                </span>
                <span className="hidden sm:inline">Invitation links valid for 72 hours</span>
              </div>
            </div>
          </div>

          {/* Dossier — inline on desktop, sheet on mobile */}
          <div className="lg:col-span-5">
            <div className="hidden lg:block">
              <DossierPanel
                member={member}
                memberState={memberState}
                events={events}
                eventsState={eventsState}
                issued={issued}
                selectedId={selectedId}
                busyId={busyId}
                onSuspend={setSuspendTarget}
                onReactivate={handleReactivate}
                onResend={handleResend}
                onRevoke={setRevokeTarget}
                onCopy={copyLink}
                onRetry={() => loadMember(selectedId)}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Mobile dossier sheet */}
      <div className="lg:hidden">
        <AdminModal open={!!selectedId} onClose={() => setSelectedId(null)} labelledBy="staff-dossier-title">
          <DossierPanel
            member={member}
            memberState={memberState}
            events={events}
            eventsState={eventsState}
            issued={issued}
            selectedId={selectedId}
            busyId={busyId}
            onSuspend={setSuspendTarget}
            onReactivate={handleReactivate}
            onResend={handleResend}
            onRevoke={setRevokeTarget}
            onCopy={copyLink}
            onRetry={() => loadMember(selectedId)}
            titleId="staff-dossier-title"
            onClose={() => setSelectedId(null)}
          />
        </AdminModal>
      </div>

      {/* ── Add Handler drawer ── */}
      <AddHandlerDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        form={form}
        setForm={setForm}
        error={formError}
        sending={sending}
        onSubmit={handleSendInvitation}
        issued={issued}
        onCopy={copyLink}
        onResend={() => handleResend(issued?.invitation)}
        onRevoke={() => issued?.invitation && setRevokeTarget(issued.invitation)}
        onDone={() => { setDrawerOpen(false); setIssued(null); }}
        busy={busyId === issued?.invitation?.id || revoking}
      />

      {/* ── Suspend confirmation ── */}
      <SuspendModal
        target={suspendTarget}
        form={suspendForm}
        setForm={setSuspendForm}
        onClose={() => setSuspendTarget(null)}
        onConfirm={handleSuspend}
        busy={suspending}
      />

      {/* ── Revoke confirmation ── */}
      <AdminModal open={!!revokeTarget} onClose={() => setRevokeTarget(null)} labelledBy="revoke-invite-title">
        <div className="p-6">
          <div className="flex items-start gap-3">
            <span className="w-10 h-10 rounded-full bg-[var(--color-danger-soft-bg)] text-[var(--color-danger-soft-fg)] flex items-center justify-center shrink-0">
              <span className="material-symbols-outlined text-[22px]">undo</span>
            </span>
            <div>
              <h3 id="revoke-invite-title" className="font-serif text-[22px] text-[var(--color-botanical-text)] dark:text-[#f0ede9]">
                Revoke this invitation?
              </h3>
              <p className="text-[13px] text-[var(--color-botanical-muted)] mt-1">
                The activation link stops working immediately. The person will need a brand-new invitation.
              </p>
            </div>
          </div>
          <div className="mt-4 px-3.5 py-2.5 rounded-xl bg-[var(--color-surface-container)] flex items-center justify-between text-[12px] dark:bg-[#2e2a25]">
            <span className="font-semibold text-[var(--color-botanical-text)] dark:text-[#f0ede9]">
              {revokeTarget?.name || revokeTarget?.recipientName}
            </span>
            <span className="text-[var(--color-botanical-muted)]">
              {revokeTarget?.email || revokeTarget?.recipientEmail}
            </span>
          </div>
          <div className="mt-5 flex items-center justify-end gap-2">
            <StaffButton variant="ghost" onClick={() => setRevokeTarget(null)}>Cancel</StaffButton>
            <StaffButton variant="danger" icon="undo" loading={revoking} onClick={handleRevoke}>
              Revoke Invitation
            </StaffButton>
          </div>
        </div>
      </AdminModal>

      <AdminToast toast={toast} onDismiss={() => setToast(null)} />
    </AdminLayout>
  );
}

// ── Presentational pieces ──────────────────────────────────────────────────

function KpiCard({ label, value, icon, footnote, tag, tone = 'primary', tagTone = 'muted' }) {
  const iconTone = {
    primary: 'bg-[var(--color-surface-container)] text-[var(--color-botanical-text)] dark:bg-[#2e2a25] dark:text-[#f0ede9]',
    accent: 'bg-[var(--color-badge-bg)] text-[var(--color-badge-fg-strong)]',
    sage: 'bg-[var(--color-success-soft-bg)] text-[var(--color-success-soft-fg)]',
    danger: 'bg-[var(--color-danger-soft-bg)] text-[var(--color-danger-soft-fg)]',
  }[tone];
  const tagToneClass = {
    muted: 'bg-[var(--color-surface-container)] text-[var(--color-botanical-muted)] dark:bg-[#2e2a25]',
    accent: 'bg-[var(--color-badge-bg)] text-[var(--color-badge-fg-strong)]',
    sage: 'bg-[var(--color-success-soft-bg)] text-[var(--color-success-soft-fg)]',
    danger: 'bg-[var(--color-danger-soft-bg)] text-[var(--color-danger-soft-fg)]',
  }[tagTone];

  return (
    <div className="p-5 rounded-2xl bg-[var(--color-surface-lowest)] shadow-[0_4px_20px_-2px_rgba(46,36,30,0.05)] dark:bg-[#1f1c19]">
      <div className="flex items-start justify-between">
        <div>
          <span className="block text-[11px] font-bold uppercase tracking-wider text-[var(--color-botanical-muted)]">
            {label}
          </span>
          <span className="block font-serif text-[30px] leading-tight text-[var(--color-botanical-text)] mt-1 dark:text-[#f0ede9]">
            {value === null || value === undefined ? '—' : String(value).padStart(2, '0')}
          </span>
        </div>
        <span className={`w-10 h-10 rounded-full flex items-center justify-center ${iconTone}`}>
          <span className="material-symbols-outlined text-[20px]">{icon}</span>
        </span>
      </div>
      <div className="mt-3.5 pt-3 border-t border-[var(--color-divider)] flex items-center justify-between gap-2">
        <span className="text-[12px] text-[var(--color-botanical-muted)] truncate">{footnote}</span>
        {tag && (
          <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider shrink-0 ${tagToneClass}`}>
            {tag}
          </span>
        )}
      </div>
    </div>
  );
}

function Row({ row, selected, busy, onSelect, onResend, onRevoke, onReactivate }) {
  const a = row.actions || {};
  const isInvitation = row.kind === 'invitation';
  return (
    <tr
      className={`transition-colors cursor-pointer ${
        selected ? 'bg-[var(--color-btn)]/5' : 'hover:bg-[var(--color-surface-low)]/70'
      }`}
      onClick={onSelect}
    >
      <td className="py-3.5 px-5">
        <div className="flex items-center gap-3">
          <StaffAvatar
            initials={row.initials}
            size={36}
            tone={row.status === 'SUSPENDED' ? 'danger' : toneFor(row.id)}
          />
          <div className="min-w-0">
            <span className="block text-[13px] font-semibold text-[var(--color-botanical-text)] truncate dark:text-[#f0ede9]">
              {row.name}
            </span>
            <span className="block text-[10px] font-mono text-[var(--color-botanical-subtle)]">{row.staffId}</span>
          </div>
        </div>
      </td>
      <td className="py-3.5 px-3">
        <StaffRoleBadge roleBadge={row.roleBadge} />
      </td>
      <td className="py-3.5 px-3 text-[12px] text-[var(--color-botanical-muted)] truncate max-w-[150px]">
        {row.department || '—'}
      </td>
      <td className="py-3.5 px-3">
        <StaffStatusPill status={row.status} />
      </td>
      <td className="py-3.5 px-3 text-[12px] text-[var(--color-botanical-muted)] whitespace-nowrap">
        {formatDate(row.createdAt)}
      </td>
      <td className="py-3.5 px-3 text-[12px] whitespace-nowrap">
        {row.status === 'SUSPENDED' ? (
          <span className="text-[var(--color-danger)] font-semibold">Suspended</span>
        ) : isInvitation ? (
          <span className="text-[var(--color-accent)] font-medium">{countdown(row.expiresAt)}</span>
        ) : row.lastActiveAt ? (
          <span className="text-[var(--color-botanical-muted)]">{row.lastActiveLabel}</span>
        ) : (
          <span className="text-[var(--color-botanical-subtle)]">Never signed in</span>
        )}
      </td>
      <td className="py-3.5 px-5 text-right" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-end gap-1.5">
          {a.canResend && (
            <button
              type="button"
              disabled={busy}
              onClick={onResend}
              className="px-2.5 py-1 rounded-full bg-[var(--color-surface-container)] text-[11px] font-semibold text-[var(--color-botanical-text)] hover:bg-[var(--color-surface-high)] transition-colors disabled:opacity-50 dark:bg-[#2e2a25] dark:text-[#f0ede9]"
            >
              {busy ? 'Resending…' : 'Resend'}
            </button>
          )}
          {a.canRevoke && (
            <button
              type="button"
              onClick={onRevoke}
              className="px-2.5 py-1 rounded-full text-[11px] font-semibold text-[var(--color-danger)] hover:bg-[var(--color-danger-soft-bg)] transition-colors"
            >
              Revoke
            </button>
          )}
          {a.canReactivate && (
            <button
              type="button"
              disabled={busy}
              onClick={onReactivate}
              className="px-2.5 py-1 rounded-full bg-[var(--color-success-soft-bg)] text-[11px] font-semibold text-[var(--color-success-soft-fg)] hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              Reactivate
            </button>
          )}
          {a.canSuspend && (
            <button
              type="button"
              onClick={() => onSuspend(row)}
              className="px-2.5 py-1 rounded-full text-[11px] font-semibold text-[var(--color-botanical-muted)] hover:bg-[var(--color-danger-soft-bg)] hover:text-[var(--color-danger)] transition-colors"
            >
              Suspend
            </button>
          )}
          {!a.canSuspend && !a.canReactivate && !a.canResend && !a.canRevoke && (
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-[var(--color-surface-container)] text-[10px] font-bold uppercase tracking-wider text-[var(--color-botanical-subtle)] dark:bg-[#2e2a25]">
              <span className="material-symbols-outlined text-[13px]">lock</span>
              Protected
            </span>
          )}
        </div>
        {a.note && (
          <span className="block text-[10px] text-[var(--color-botanical-subtle)] mt-1">{a.note}</span>
        )}
      </td>
    </tr>
  );
}

function DossierPanel({
  member, memberState, events, eventsState, issued, selectedId,
  busyId, onSuspend, onReactivate, onResend, onRevoke, onCopy, onRetry,
  titleId = 'dossier-title', onClose = null,
}) {
  if (!selectedId) {
    return (
      <div className="rounded-2xl bg-[var(--color-surface-lowest)] shadow-[0_4px_20px_-2px_rgba(46,36,30,0.05)] dark:bg-[#1f1c19]">
        <StaffEmptyState
          icon="badge"
          title="Select a staff member"
          description="Choose someone from the roster to see their dossier, lifecycle actions and recorded history."
        />
      </div>
    );
  }
  if (memberState === 'loading') {
    return (
      <div className="rounded-2xl bg-[var(--color-surface-lowest)] shadow-[0_4px_20px_-2px_rgba(46,36,30,0.05)] dark:bg-[#1f1c19]">
        <StaffCardSkeleton />
      </div>
    );
  }
  if (memberState === 'error' || !member) {
    return (
      <div className="rounded-2xl bg-[var(--color-surface-lowest)] shadow-[0_4px_20px_-2px_rgba(46,36,30,0.05)] dark:bg-[#1f1c19]">
        <StaffEmptyState
          icon="error"
          title="Could not load this dossier"
          description="The record may have been removed, or the server could not be reached."
          action={<StaffButton icon="refresh" onClick={onRetry}>Try again</StaffButton>}
        />
      </div>
    );
  }

  const a = member.actions || {};
  const isInvitation = member.kind === 'invitation';
  const linkJustMinted = issued && issued.invitation?.id === member.id;

  return (
    <div className="rounded-2xl bg-[var(--color-surface-lowest)] shadow-[0_12px_32px_-6px_rgba(46,36,30,0.10)] overflow-hidden dark:bg-[#1f1c19]">
      <div className="p-5 bg-gradient-to-br from-[var(--color-surface-container)] via-[var(--color-surface-low)] to-[var(--color-surface-lowest)] dark:from-[#2e2a25] dark:via-[#26221e] dark:to-[#1f1c19]">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <StaffAvatar
              initials={member.initials}
              size={56}
              radius="lg"
              tone={member.status === 'SUSPENDED' ? 'danger' : toneFor(member.id)}
            />
            <div className="min-w-0">
              <h2 id={titleId} className="font-serif text-[22px] leading-tight text-[var(--color-botanical-text)] truncate dark:text-[#f0ede9]">
                {member.name}
              </h2>
              <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                <StaffStatusPill status={member.status} />
                <StaffRoleBadge roleBadge={member.roleBadge} />
              </div>
            </div>
          </div>
          {onClose && (
            <button type="button" onClick={onClose} aria-label="Close dossier" className="text-[var(--color-botanical-subtle)] hover:text-[var(--color-botanical-text)]">
              <span className="material-symbols-outlined text-[20px]">close</span>
            </button>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3 mt-4 p-3.5 rounded-xl bg-[var(--color-surface-lowest)]/80 shadow-sm dark:bg-[#1f1c19]/80">
          <MetaField label={isInvitation ? 'Invitation ID' : 'Staff ID'} value={member.staffId} mono />
          <MetaField label="Email" value={member.email} icon="alternate_email" />
          <MetaField label="Phone" value={member.phone} icon="call" />
          <MetaField label="Department" value={member.department} icon="hub" />
          <MetaField label={isInvitation ? 'Invited on' : 'Joined'} value={formatDate(member.createdAt)} icon="event" />
          <MetaField label="Invited by" value={member.invitedByName} icon="person" />
          {!isInvitation && (
            <MetaField label="Last active" value={member.lastActiveAt ? formatDateTime(member.lastActiveAt) : 'Never signed in'} icon="schedule" />
          )}
          {isInvitation && (
            <MetaField label="Expires" value={`${formatDateTime(member.expiresAt)} · ${countdown(member.expiresAt)}`} icon="timer" />
          )}
          {member.suspension?.reason && (
            <MetaField
              className="col-span-2"
              label="Suspension reason"
              value={`${member.suspension.reason}${member.suspension.note ? ` — ${member.suspension.note}` : ''}`}
              icon="block"
            />
          )}
        </div>
      </div>

      {/* Actions — only what the server says this actor may do */}
      <div className="p-5 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-botanical-subtle)]">
            Lifecycle Actions
          </span>
          {member.isSelf && (
            <span className="text-[10px] font-bold uppercase text-[var(--color-accent)]">Your account</span>
          )}
        </div>

        {a.canSuspend && (
          <StaffButton variant="dangerSoft" icon="block" className="w-full" onClick={() => onSuspend(member)}>
            Suspend Staff Member
          </StaffButton>
        )}
        {a.canReactivate && (
          <StaffButton
            variant="secondary"
            icon="restart_alt"
            className="w-full"
            loading={busyId === member.id}
            onClick={() => onReactivate(member)}
          >
            Reactivate Staff Member
          </StaffButton>
        )}
        {a.canResend && (
          <StaffButton
            variant="secondary"
            icon="forward_to_inbox"
            className="w-full"
            loading={busyId === member.id}
            onClick={() => onResend(member)}
          >
            Resend Invitation
          </StaffButton>
        )}
        {a.canRevoke && (
          <StaffButton variant="ghost" icon="undo" className="w-full" onClick={() => onRevoke(member)}>
            Revoke Invitation
          </StaffButton>
        )}

        {linkJustMinted && (
          <div className="p-3.5 rounded-xl bg-[var(--color-success-soft-bg)] text-[var(--color-success-soft-fg)]">
            <span className="block text-[10px] font-bold uppercase tracking-wider mb-1">
              Fresh activation link — shown once
            </span>
            <p className="text-[11px] break-all font-mono leading-snug">{issued.link}</p>
            <button
              type="button"
              onClick={() => onCopy(issued.link)}
              className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[var(--color-btn)] text-white text-[11px] font-semibold"
            >
              <span className="material-symbols-outlined text-[15px]">content_copy</span>
              Copy link
            </button>
          </div>
        )}

        {a.canResend && !linkJustMinted && (
          <p className="text-[11px] leading-snug text-[var(--color-botanical-subtle)]">
            Activation links are shown once, at the moment they are created. Use Resend to mint a new one.
          </p>
        )}
        {a.note && (
          <p className="text-[11px] leading-snug text-[var(--color-botanical-muted)] flex items-start gap-1.5">
            <span className="material-symbols-outlined text-[15px] shrink-0">shield</span>
            {a.note}
          </p>
        )}
        {!a.canSuspend && !a.canReactivate && !a.canResend && !a.canRevoke && !a.note && (
          <p className="text-[11px] text-[var(--color-botanical-subtle)]">No lifecycle actions are available for this record.</p>
        )}
      </div>

      {/* Audit timeline */}
      <div className="px-5 pb-5">
        <div className="flex items-center justify-between mb-3">
          <span className="font-serif text-[17px] text-[var(--color-botanical-text)] dark:text-[#f0ede9]">Activity</span>
          <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-botanical-subtle)]">
            Recorded events
          </span>
        </div>

        {eventsState === 'loading' && (
          <div className="space-y-3" role="status" aria-label="Loading activity">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex gap-3">
                <div className="w-3 h-3 rounded-full bg-[var(--color-surface-high)] animate-pulse mt-1" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-3 w-32 rounded bg-[var(--color-surface-high)] animate-pulse" />
                  <div className="h-3 w-48 rounded bg-[var(--color-surface-container)] animate-pulse" />
                </div>
              </div>
            ))}
          </div>
        )}

        {eventsState === 'error' && (
          <p className="text-[12px] text-[var(--color-botanical-muted)]">Could not load the activity log.</p>
        )}

        {eventsState === 'ready' && events.length === 0 && (
          <p className="text-[12px] leading-relaxed text-[var(--color-botanical-muted)] p-3.5 rounded-xl bg-[var(--color-surface-low)] dark:bg-[#26221e]">
            No activity has been recorded for this record yet. Events are logged as they happen — nothing
            here is reconstructed after the fact.
          </p>
        )}

        {eventsState === 'ready' && events.length > 0 && (
          <div className="relative pl-5 space-y-4 before:content-[''] before:absolute before:left-[5px] before:top-2 before:bottom-2 before:w-0.5 before:bg-[var(--color-divider-strong)]">
            {events.map((ev) => (
              <div key={ev.id} className="relative">
                <span className={`absolute -left-5 top-1.5 w-3 h-3 rounded-full ring-4 ring-[var(--color-surface-lowest)] dark:ring-[#1f1c19] ${eventDot(ev.type)}`} />
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[12px] font-semibold text-[var(--color-botanical-text)] dark:text-[#f0ede9]">
                    {eventLabel(ev.type)}
                  </span>
                  <span className="text-[10px] uppercase tracking-wider text-[var(--color-botanical-subtle)] whitespace-nowrap">
                    {ev.atLabel}
                  </span>
                </div>
                <p className="text-[12px] leading-snug text-[var(--color-botanical-muted)] mt-0.5 break-words">
                  {ev.message}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function eventLabel(type) {
  return {
    INVITATION_CREATED: 'Invitation issued',
    INVITATION_RESENT: 'Invitation resent',
    INVITATION_REVOKED: 'Invitation revoked',
    ACCOUNT_ACTIVATED: 'Account activated',
    ACCOUNT_CREATED: 'Account created',
    LOGIN: 'Signed in',
    SUSPENDED: 'Suspended',
    REACTIVATED: 'Reactivated',
    ROLE_CHANGED: 'Role changed',
    PROFILE_UPDATED: 'Profile updated',
  }[type] || 'Activity';
}

function eventDot(type) {
  if (type === 'SUSPENDED') return 'bg-[var(--color-danger)]';
  if (type === 'REACTIVATED' || type === 'ACCOUNT_ACTIVATED') return 'bg-[var(--color-botanical-sage)]';
  if (type === 'INVITATION_CREATED' || type === 'INVITATION_RESENT' || type === 'INVITATION_REVOKED') return 'bg-[var(--color-accent)]';
  if (type === 'LOGIN') return 'bg-[var(--color-botanical-sage)]';
  return 'bg-[var(--color-botanical-subtle)]';
}

/** Right-hand slide-over: issue an invitation, then show it exactly once. */
function AddHandlerDrawer({
  open, onClose, form, setForm, error, sending, onSubmit, issued,
  onCopy, onResend, onRevoke, onDone, busy,
}) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === 'Escape' && onClose();
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  const field = (name, value) => setForm((f) => ({ ...f, [name]: value }));

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-[#180f0a]/45 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-handler-title"
        className="relative w-full sm:max-w-lg h-full bg-[var(--color-surface-lowest)] shadow-[0_12px_32px_-4px_rgba(46,36,30,0.30)] flex flex-col dark:bg-[#1f1c19] animate-slide-in"
      >
        {issued ? (
          <>
            <div className="p-6 bg-[var(--color-success-soft-bg)] text-[var(--color-success-soft-fg)]">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-[20px]">mark_email_read</span>
                  <span className="text-[10px] font-bold uppercase tracking-widest">Invitation Issued</span>
                </div>
                <button type="button" onClick={onDone} aria-label="Close" className="opacity-70 hover:opacity-100">
                  <span className="material-symbols-outlined text-[20px]">close</span>
                </button>
              </div>
              <h2 id="add-handler-title" className="font-serif text-[26px] mt-2 leading-tight">
                {issued.invitation?.recipientName || issued.invitation?.recipientEmail} has been invited
              </h2>
              <p className="text-[13px] mt-1 opacity-90">
                They activate their own account with this single-use link. It expires in 72 hours.
              </p>
            </div>
            <div className="p-6 flex-1 overflow-y-auto space-y-4">
              <div className="p-4 rounded-xl bg-[var(--color-surface-low)] space-y-3 dark:bg-[#26221e]">
                <div className="flex justify-between gap-3 text-[12px]">
                  <span className="text-[var(--color-botanical-muted)]">Recipient</span>
                  <span className="font-semibold text-[var(--color-botanical-text)] dark:text-[#f0ede9]">
                    {issued.invitation?.recipientName}
                  </span>
                </div>
                <div className="flex justify-between gap-3 text-[12px]">
                  <span className="text-[var(--color-botanical-muted)]">Work email</span>
                  <span className="text-[var(--color-botanical-text)] truncate dark:text-[#f0ede9]">
                    {issued.invitation?.recipientEmail}
                  </span>
                </div>
                <div className="flex justify-between gap-3 text-[12px]">
                  <span className="text-[var(--color-botanical-muted)]">Invitation ID</span>
                  <span className="font-mono text-[var(--color-botanical-text)] dark:text-[#f0ede9]">
                    {issued.invitation?.invitationId}
                  </span>
                </div>
                <div className="flex justify-between gap-3 text-[12px]">
                  <span className="text-[var(--color-botanical-muted)]">Role</span>
                  <span className="font-semibold text-[var(--color-botanical-text)] dark:text-[#f0ede9]">Handler</span>
                </div>
                <div className="flex justify-between gap-3 text-[12px]">
                  <span className="text-[var(--color-botanical-muted)]">Invited by</span>
                  <span className="text-[var(--color-botanical-text)] dark:text-[#f0ede9]">
                    {issued.invitation?.invitedByName}
                  </span>
                </div>
                <div className="flex justify-between gap-3 text-[12px]">
                  <span className="text-[var(--color-botanical-muted)]">Status</span>
                  <StaffStatusPill status={issued.invitation?.status} />
                </div>
                <div className="flex justify-between gap-3 text-[12px]">
                  <span className="text-[var(--color-botanical-muted)]">Expires</span>
                  <span className="text-[var(--color-botanical-text)] dark:text-[#f0ede9]">
                    {formatDateTime(issued.invitation?.expiresAt)}
                  </span>
                </div>
              </div>

              <div className="p-4 rounded-xl bg-[var(--color-surface-container)] space-y-2 dark:bg-[#2e2a25]">
                <span className="block text-[10px] font-bold uppercase tracking-wider text-[var(--color-botanical-muted)]">
                  Activation link — shown once
                </span>
                <p className="text-[11px] font-mono break-all leading-snug text-[var(--color-botanical-text)] dark:text-[#f0ede9]">
                  {issued.link}
                </p>
                <p className="text-[11px] text-[var(--color-botanical-muted)]">
                  For your security this link is never stored or shown again. Resending mints a new one and
                  invalidates this.
                </p>
              </div>
            </div>
            <div className="p-5 bg-[var(--color-surface-low)] flex flex-wrap items-center justify-end gap-2 dark:bg-[#26221e]">
              <StaffButton variant="ghost" icon="undo" onClick={onRevoke}>Revoke</StaffButton>
              <StaffButton variant="secondary" icon="forward_to_inbox" loading={busy} onClick={onResend}>
                Resend
              </StaffButton>
              <StaffButton variant="primary" icon="content_copy" onClick={() => onCopy(issued.link)}>
                Copy Link
              </StaffButton>
              <StaffButton variant="primary" icon="check" onClick={onDone}>Done</StaffButton>
            </div>
          </>
        ) : (
          <form onSubmit={onSubmit} className="flex flex-col h-full">
            <div className="p-6 bg-[var(--color-surface-low)] dark:bg-[#26221e]">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-[var(--color-accent)]" />
                  <span className="text-[10px] font-bold uppercase tracking-widest text-[var(--color-accent)]">
                    New Staff Invitation
                  </span>
                </div>
                <button type="button" onClick={onClose} aria-label="Close" className="text-[var(--color-botanical-subtle)] hover:text-[var(--color-botanical-text)]">
                  <span className="material-symbols-outlined text-[20px]">close</span>
                </button>
              </div>
              <h2 id="add-handler-title" className="font-serif text-[28px] text-[var(--color-botanical-text)] mt-1 dark:text-[#f0ede9]">
                Add Handler
              </h2>
              <p className="text-[14px] text-[var(--color-botanical-muted)] mt-1">
                Invite an operational staff member to join your atelier floor and access fulfilment queues.
              </p>
              <div className="mt-4 p-3.5 rounded-xl bg-[var(--color-surface-high)]/60 flex items-start gap-3 dark:bg-[#37332c]/60">
                <span className="w-7 h-7 rounded-full bg-[var(--color-btn)] text-white flex items-center justify-center shrink-0 mt-0.5">
                  <span className="material-symbols-outlined text-[15px]">badge</span>
                </span>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-botanical-text)] dark:text-[#f0ede9]">Role:</span>
                    <span className="px-2 py-0.5 rounded-full bg-[var(--color-btn)] text-white text-[10px] font-bold uppercase tracking-wider">Handler</span>
                  </div>
                  <p className="text-[12px] text-[var(--color-botanical-muted)] mt-1">
                    Operational scope — handlers cannot manage staff permissions or administrator accounts.
                  </p>
                </div>
              </div>
            </div>

            <div className="p-6 flex-1 overflow-y-auto space-y-4">
              <DrawerField label="Full Name" required hint="Legal or preferred badge name">
                <span className="material-symbols-outlined absolute left-3.5 top-1/2 -translate-y-1/2 text-[18px] text-[var(--color-botanical-subtle)]">person</span>
                <input
                  type="text"
                  required
                  value={form.name}
                  onChange={(e) => field('name', e.target.value)}
                  placeholder="e.g. Devika Mehra"
                  className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-[var(--color-surface-low)] text-[14px] text-[var(--color-botanical-text)] outline-none focus:ring-2 focus:ring-[var(--color-focus)] dark:bg-[#26221e] dark:text-[#f0ede9]"
                />
              </DrawerField>

              <DrawerField label="Work Email" required hint="Invitation is sent here">
                <span className="material-symbols-outlined absolute left-3.5 top-1/2 -translate-y-1/2 text-[18px] text-[var(--color-botanical-subtle)]">mail</span>
                <input
                  type="email"
                  required
                  value={form.email}
                  onChange={(e) => field('email', e.target.value)}
                  placeholder="handler@example.com"
                  className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-[var(--color-surface-low)] text-[14px] text-[var(--color-botanical-text)] outline-none focus:ring-2 focus:ring-[var(--color-focus)] dark:bg-[#26221e] dark:text-[#f0ede9]"
                />
              </DrawerField>

              <DrawerField label="Phone Number" hint="For urgent floor dispatches">
                <span className="material-symbols-outlined absolute left-3.5 top-1/2 -translate-y-1/2 text-[18px] text-[var(--color-botanical-subtle)]">call</span>
                <input
                  type="tel"
                  value={form.phone}
                  onChange={(e) => field('phone', e.target.value)}
                  placeholder="+91 98450 12389"
                  className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-[var(--color-surface-low)] text-[14px] text-[var(--color-botanical-text)] outline-none focus:ring-2 focus:ring-[var(--color-focus)] dark:bg-[#26221e] dark:text-[#f0ede9]"
                />
              </DrawerField>

              <DrawerField label="Department / Responsibility" required>
                <span className="material-symbols-outlined absolute left-3.5 top-1/2 -translate-y-1/2 text-[18px] text-[var(--color-botanical-subtle)]">hub</span>
                <select
                  value={form.department}
                  onChange={(e) => field('department', e.target.value)}
                  className="w-full pl-10 pr-9 py-2.5 rounded-xl bg-[var(--color-surface-low)] text-[14px] text-[var(--color-botanical-text)] outline-none focus:ring-2 focus:ring-[var(--color-focus)] cursor-pointer dark:bg-[#26221e] dark:text-[#f0ede9]"
                >
                  {DEPARTMENTS.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
                <span className="material-symbols-outlined absolute right-3.5 top-1/2 -translate-y-1/2 text-[18px] text-[var(--color-botanical-subtle)] pointer-events-none">expand_more</span>
              </DrawerField>

              <DrawerField label="Assignment Notes" hint="Internal note only">
                <textarea
                  rows={3}
                  value={form.notes}
                  onChange={(e) => field('notes', e.target.value)}
                  placeholder="e.g. Assigned to Workbench B-02 under the floor supervisor"
                  className="w-full p-3.5 rounded-xl bg-[var(--color-surface-low)] text-[14px] text-[var(--color-botanical-text)] outline-none focus:ring-2 focus:ring-[var(--color-focus)] resize-none dark:bg-[#26221e] dark:text-[#f0ede9]"
                />
              </DrawerField>

              <div className="p-3.5 rounded-xl bg-[var(--color-success-soft-bg)]/40 flex items-start gap-3">
                <span className="material-symbols-outlined text-[20px] text-[var(--color-success-soft-fg)] mt-0.5">info</span>
                <p className="text-[12px] text-[var(--color-botanical-muted)]">
                  Handlers receive operational access to assigned orders and inventory tasks. The role cannot be
                  chosen here — this endpoint only creates handlers, and the server enforces that.
                </p>
              </div>

              {error && (
                <div className="p-3.5 rounded-xl bg-[var(--color-danger-soft-bg)] text-[var(--color-danger-soft-fg)] flex items-start gap-2">
                  <span className="material-symbols-outlined text-[18px] mt-0.5">error</span>
                  <p className="text-[12px] leading-snug">{error}</p>
                </div>
              )}
            </div>

            <div className="p-5 bg-[var(--color-surface-low)] flex items-center gap-3 dark:bg-[#26221e]">
              <StaffButton variant="secondary" className="w-1/2" onClick={onClose}>Cancel</StaffButton>
              <StaffButton type="submit" variant="primary" icon="send" className="w-1/2" loading={sending}>
                {sending ? 'Sending…' : 'Send Invitation'}
              </StaffButton>
            </div>
          </form>
        )}
      </aside>
    </div>
  );
}

function DrawerField({ label, hint, required, children }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="flex items-center justify-between text-[11px] font-bold uppercase tracking-wider text-[var(--color-botanical-text)] dark:text-[#f0ede9]">
        <span>
          {label} {required && <span className="text-[var(--color-accent)]">*</span>}
        </span>
        {hint && <span className="text-[10px] font-normal normal-case tracking-normal text-[var(--color-botanical-subtle)]">{hint}</span>}
      </label>
      <div className="relative flex items-center">{children}</div>
    </div>
  );
}

function SuspendModal({ target, form, setForm, onClose, onConfirm, busy }) {
  useEffect(() => {
    if (!target) return undefined;
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [target, onClose]);

  return (
    <AdminModal open={!!target} onClose={onClose} labelledBy="suspend-title">
      <div className="p-6">
        <div className="flex items-start gap-3">
          <span className="w-10 h-10 rounded-full bg-[var(--color-danger-soft-bg)] text-[var(--color-danger)] flex items-center justify-center shrink-0">
            <span className="material-symbols-outlined text-[22px]">warning</span>
          </span>
          <div>
            <h3 id="suspend-title" className="font-serif text-[22px] text-[var(--color-botanical-text)] dark:text-[#f0ede9]">
              Suspend this staff member?
            </h3>
            <p className="text-[13px] text-[var(--color-botanical-muted)] mt-1">
              They lose access to the staff portal on their very next request — even with a valid session.
              Open work stays assigned and can be picked up again after reactivation.
            </p>
          </div>
        </div>

        <div className="mt-4 px-3.5 py-2.5 rounded-xl bg-[var(--color-surface-container)] flex items-center justify-between gap-3 text-[12px] dark:bg-[#2e2a25]">
          <span className="font-semibold text-[var(--color-botanical-text)] dark:text-[#f0ede9]">
            {target?.name} <span className="font-mono font-normal text-[var(--color-botanical-subtle)]">({target?.staffId})</span>
          </span>
          <span className="text-[var(--color-botanical-muted)] truncate">{target?.department || target?.roleLabel}</span>
        </div>

        <div className="mt-4 space-y-3">
          <div>
            <label htmlFor="suspend-reason" className="block text-[11px] font-bold uppercase tracking-wider text-[var(--color-botanical-muted)] mb-1.5">
              Suspension reason
            </label>
            <div className="relative flex items-center">
              <select
                id="suspend-reason"
                value={form.reason}
                onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
                className="w-full pl-3.5 pr-9 py-2.5 rounded-xl bg-[var(--color-surface-low)] text-[14px] text-[var(--color-botanical-text)] outline-none focus:ring-2 focus:ring-[var(--color-focus)] cursor-pointer dark:bg-[#26221e] dark:text-[#f0ede9]"
              >
                {SUSPENSION_REASONS.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
              </select>
              <span className="material-symbols-outlined absolute right-3 text-[18px] text-[var(--color-botanical-subtle)] pointer-events-none">expand_more</span>
            </div>
          </div>
          <div>
            <label htmlFor="suspend-note" className="block text-[11px] font-bold uppercase tracking-wider text-[var(--color-botanical-muted)] mb-1.5">
              Audit notes (optional)
            </label>
            <textarea
              id="suspend-note"
              rows={2}
              value={form.note}
              onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
              placeholder="Record specifics for the operations ledger…"
              className="w-full p-3.5 rounded-xl bg-[var(--color-surface-low)] text-[14px] text-[var(--color-botanical-text)] outline-none focus:ring-2 focus:ring-[var(--color-focus)] resize-none dark:bg-[#26221e] dark:text-[#f0ede9]"
            />
          </div>
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <StaffButton variant="ghost" onClick={onClose}>Cancel</StaffButton>
          <StaffButton variant="danger" icon="block" loading={busy} onClick={onConfirm}>
            Confirm Suspension
          </StaffButton>
        </div>
      </div>
    </AdminModal>
  );
}
