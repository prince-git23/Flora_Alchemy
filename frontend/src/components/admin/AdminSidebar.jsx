import React from 'react';
import { NavLink, useLocation, Link, useNavigate } from 'react-router-dom';
import { useAdminSession } from '../../context/AdminSessionContext.jsx';
import { portalForSession, loginPathForPortal, PORTAL_META } from '../../services/authService.js';
import { sessionHasPermission } from '../../services/staffAccessService.js';

/**
 * Phase 21 — which navigation a PORTAL sees, expressed as BUSINESS groups
 * (not raw database entities):
 *
 *  admin  → Dashboard · STORE · CUSTOMERS · INSIGHTS · ADMINISTRATION
 *           (ADMINISTRATION carries the admin's special duty: Staff Members)
 *  owner  → OWNER GOVERNANCE · ADMINISTRATION  [Phase 22.4 trim]
 *           (the Owner Portal is governance-only: applications, administrators,
 *            staff, invitations, platform settings + access. Operational STORE/
 *            CUSTOMERS/INSIGHTS groups were removed — every one of those
 *            surfaces is workspace-scoped and returns 403 WORKSPACE_REQUIRED
 *            for the workspace-null owner anyway; the owner reviews businesses,
 *            they do not run one console. Settings is relabelled "Platform
 *            Settings" because it holds platform-wide defaults + fixture data.)
 *  staff  → Dashboard · OPERATIONS · CUSTOMER SERVICE · INSIGHTS
 *           (no Staff Members, no Access, no Settings — the backend returns
 *            403 for handler sessions on those endpoints regardless)
 *
 * The portal is derived from the server-resolved session (role + isOwner),
 * never from the URL the user happened to open. Hiding a link is UX only — the
 * backend returns 403 regardless of what the sidebar renders.
 */
function buildNavGroups(groups, session) {
  const byGroup = Object.fromEntries(groups.map((g) => [g.group, g]));
  const portal = portalForSession(session);

  if (portal === 'staff') {
    /**
     * GRANULAR STAFF ACCESS — a nav item is rendered only when the session
     * holds at least one of the permissions it needs (`any`). The list comes
     * from the CURRENT server identity (/auth/me at shell mount), so a
     * permission an administrator removed disappears from the sidebar without
     * a re-login.
     *
     * HIDDEN UI IS NOT SECURITY: every one of these routes is enforced by
     * permissionMiddleware on the server, which re-reads the account on each
     * request. This only avoids offering a door that answers 403.
     */
    const can = (ids) => (ids || []).some((id) => sessionHasPermission(session, id));
    const groups = [
      {
        group: 'OVERVIEW',
        items: [
          { name: 'Dashboard', path: '/staff/dashboard', aliases: ['/staff'], icon: 'dashboard' },
          // Phase 23 — the Action Center: every operational action a handler is
          // assigned, assembled from the workspace's existing work records. It
          // is backed by orders, custom requests, stock and conversations, so
          // it needs at least ONE of those read permissions.
          {
            name: 'Action Center',
            path: '/staff/work',
            icon: 'task_alt',
            any: ['orders.view', 'requests.view', 'inventory.view', 'conversations.view'],
          },
        ],
      },
      {
        group: 'OPERATIONS',
        items: [
          { name: 'Orders', path: '/staff/orders', icon: 'shopping_bag', any: ['orders.view'] },
          { name: 'Products', path: '/staff/products', icon: 'inventory_2', any: ['products.view'] },
          { name: 'Collections', path: '/staff/collections', icon: 'auto_stories', any: ['collections.view'] },
          {
            name: 'Inventory',
            path: '/staff/inventory',
            icon: 'warehouse',
            any: ['inventory.view', 'inventory.movement.view'],
          },
        ],
      },
      {
        group: 'CUSTOMER SERVICE',
        items: [
          { name: 'Customers', path: '/staff/customers', icon: 'group', any: ['customers.view'] },
          { name: 'Conversations', path: '/staff/conversations', icon: 'chat', any: ['conversations.view'] },
          { name: 'Custom Requests', path: '/staff/custom-requests', icon: 'draw', any: ['requests.view'] },
        ],
      },
      {
        group: 'INSIGHTS',
        items: [
          { name: 'Analytics', path: '/staff/analytics', icon: 'analytics', any: ['analytics.view'] },
          { name: 'Notifications', path: '/staff/notifications', icon: 'notifications', any: ['notifications.view'] },
        ],
      },
    ];
    // An item without `any` is always visible (the dashboard). A group with no
    // visible item is dropped entirely rather than leaving an empty heading.
    return groups
      .map((g) => ({ ...g, items: g.items.filter((i) => (i.any ? can(i.any) : true)) }))
      .filter((g) => g.items.length > 0);
  }

  if (portal === 'owner') {
    // Phase 22.4 — governance-only trim: STORE/CUSTOMERS/INSIGHTS are gone
    // (workspace-scoped, 403 for the owner) and Settings is relabelled
    // "Platform Settings" — it administers platform-wide defaults, not a
    // single shop's preferences.
    const ownerAdministration = {
      group: 'ADMINISTRATION',
      items: [
        { name: 'Platform Settings', path: '/admin/settings', aliases: ['/admin/store-preferences', '/admin/settings/commerce'], icon: 'settings' },
        { name: 'Access', path: '/admin/access', icon: 'shield_person' },
      ],
    };
    return [
      {
        group: 'OWNER GOVERNANCE',
        items: [
          { name: 'Dashboard', path: '/owner/dashboard', aliases: ['/owner'], icon: 'workspace_premium' },
          { name: 'Shops', path: '/owner/shops', icon: 'storefront' },
          { name: 'Admin Applications', path: '/owner/applications', icon: 'assignment' },
          { name: 'Administrators', path: '/owner/administrators', icon: 'admin_panel_settings' },
          { name: 'Staff Directory', path: '/owner/staff', icon: 'badge' },
          { name: 'Invitations', path: '/owner/invitations', icon: 'mail' },
        ],
      },
      ownerAdministration,
    ].filter(Boolean);
  }

  return [byGroup.OVERVIEW, byGroup.STORE, byGroup.CUSTOMERS, byGroup.INSIGHTS, byGroup.ADMINISTRATION].filter(Boolean);
}

/** Portal-aware brand subtitle for the sidebar masthead. */
function portalSubtitle(portal) {
  if (portal === 'owner') return 'Owner Console';
  if (portal === 'staff') return 'Staff Portal';
  return 'Administrator Portal';
}

export default function AdminSidebar({ isOpen, onClose }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { session, logout } = useAdminSession();
  const portal = portalForSession(session);

  const handleSignOut = () => {
    logout();
    // Return the visitor to THEIR portal's login, not a generic one.
    navigate(loginPathForPortal(portal || 'admin'));
  };


  const allGroups = [
    {
      group: 'OVERVIEW',
      items: [
        {
          name: 'Dashboard',
          path: '/admin/dashboard',
          aliases: ['/admin'],
          icon: 'dashboard'
        }
      ]
    },
    {
      // Phase 21 — the catalogue side of the business ("STORE"), the work an
      // administrator or handler performs day to day.
      group: 'STORE',
      items: [
        {
          name: 'Orders',
          path: '/admin/orders',
          icon: 'shopping_bag'
        },
        {
          name: 'Products',
          path: '/admin/products',
          icon: 'inventory_2'
        },
        {
          name: 'Collections',
          path: '/admin/collections',
          icon: 'auto_stories'
        },
        {
          name: 'Inventory',
          path: '/admin/inventory',
          icon: 'warehouse'
        }
      ]
    },
    {
      group: 'CUSTOMERS',
      items: [
        {
          name: 'Customers',
          path: '/admin/customers',
          icon: 'group'
        },
        {
          name: 'Conversations',
          path: '/admin/conversations',
          icon: 'chat'
        },
        {
          name: 'Custom Requests',
          path: '/admin/custom-requests',
          icon: 'draw'
        }
      ]
    },
    {
      group: 'INSIGHTS',
      items: [
        {
          name: 'Analytics',
          path: '/admin/analytics',
          icon: 'analytics'
        },
        {
          name: 'Notifications',
          path: '/admin/settings/notifications',
          icon: 'notifications'
        }
      ]
    },
    {
      // Phase 21 — ADMINISTRATION carries the administrator's special duty
      // (Staff Members) next to the operational settings. Staff/owner portals
      // reshape this group in buildNavGroups above; handlers never see it.
      group: 'ADMINISTRATION',
      items: [
        {
          name: 'Staff Members',
          path: '/admin/staff',
          icon: 'badge'
        },
        {
          name: 'Invitations',
          path: '/admin/invitations',
          icon: 'mail'
        },
        {
          name: 'Settings',
          path: '/admin/settings',
          aliases: ['/admin/store-preferences', '/admin/settings/commerce'],
          icon: 'settings'
        },
        {
          name: 'Access',
          path: '/admin/access',
          icon: 'shield_person'
        }
      ]
    }
  ];

  // Phase 20.6.5 — navigation is role-scoped. Hiding a link is UX, never
  // security (the backend returns 403 regardless), but shipping a handler a
  // "Staff Directory" entry they cannot open is still a broken product.
  const navGroups = React.useMemo(() => buildNavGroups(allGroups, session), [session]);

  const sidebarContent = (
    <div className="h-full flex flex-col justify-between bg-[var(--color-surface-low)] border-r border-[var(--color-botanical-border)] select-none relative overflow-hidden dark:bg-[#1e1b18] dark:border-[#3a3530]">
      {/* Ambient depth glow */}          <div className="absolute -top-16 -right-16 w-48 h-48 rounded-full bg-[var(--color-badge-bg)]/10 blur-3xl pointer-events-none dark:bg-[#964735]/5" />
      <div className="absolute bottom-24 -left-12 w-40 h-40 rounded-full bg-[var(--color-botanical-sage-light)]/10 blur-3xl pointer-events-none dark:bg-[#5b6d54]/5" />
      <div className="flex flex-col flex-1 min-h-0 relative">
        {/* Brand Header */}
        <div className="h-16 px-4 flex items-center justify-between border-b border-[var(--color-botanical-border)]/70 bg-[var(--color-surface-low)]/80 backdrop-blur-sm dark:bg-[#1e1b18]/80 dark:border-[#3a3530]/70">
          <Link to={PORTAL_META[portal || 'admin'].home} className="flex items-center gap-2.5">
            {/* Custom Botanical Emblem */}
            <div className="w-8 h-8 rounded-full bg-[var(--color-btn)] flex items-center justify-center text-white shadow-sm shrink-0">
              <span className="material-symbols-outlined text-[19px] text-[#ffdad3]">local_florist</span>
            </div>
            <div className="flex flex-col min-w-0">
              <span className="font-serif text-[18px] text-[var(--color-botanical-text)] font-medium leading-none tracking-tight dark:text-[#f0ede9]">
                Flora Alchemy
              </span>
              <span className="text-[9px] uppercase tracking-widest text-[var(--color-accent)] font-bold mt-1">
                {portalSubtitle(portal)}
              </span>
            </div>
          </Link>

          {/* Close button on mobile */}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="md:hidden p-1.5 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg text-[var(--color-botanical-muted)] hover:bg-[var(--color-surface-high)] transition-colors"
              aria-label="Close Sidebar"
            >
              <span className="material-symbols-outlined text-[20px]">close</span>
            </button>
          )}
        </div>

        {/* Grouped Navigation */}
        <div className="flex-1 overflow-y-auto px-3 py-3 space-y-4">
          {navGroups.map((group) => (
            <div key={group.group} className="space-y-1">
              <p className="px-2 text-[10px] font-bold uppercase tracking-wider text-[var(--color-botanical-subtle)] dark:text-[#8a8078]">
                {group.group}
              </p>
              <nav className="space-y-0.5">
                {(() => {
                  // Exact match wins (aliases included); otherwise a sub-route
                  // ("/admin/orders/new", "/admin/inventory/history") lights up
                  // its parent item — but never when another item matched exactly.
                  const exactMatch = (item) =>
                    location.pathname === item.path ||
                    (item.aliases && item.aliases.includes(location.pathname));
                  const hasExact = navGroups.some((g) => g.items.some(exactMatch));

                  return group.items.map((item) => {
                    const isActive = exactMatch(item) || (!hasExact && location.pathname.startsWith(`${item.path}/`));

                    return (
                      <NavLink
                        key={item.name}
                        to={item.path}
                        onClick={onClose}
                        className={`group relative flex items-center justify-between px-2.5 py-2 min-h-[44px] md:min-h-0 rounded-xl text-[13px] font-medium transition-all duration-300 ${
                          isActive
                            ? 'bg-[var(--color-btn)] text-white font-semibold shadow-md shadow-[#180f0a]/20 dark:bg-[#964735] dark:shadow-[#964735]/20'
                            : 'text-[var(--color-botanical-muted)] hover:bg-[var(--color-surface-high)] hover:text-[var(--color-botanical-text)] hover:translate-x-0.5 dark:text-[#b8b0a8] dark:hover:bg-[#33302a] dark:hover:text-[#f0ede9]'
                        }`}
                      >
                        {/* Active depth rail */}
                        {isActive && (
                          <span className="absolute -left-3 top-1/2 -translate-y-1/2 w-1 h-5 rounded-full bg-[#964735] shadow-sm" aria-hidden="true" />
                        )}
                        <div className="flex items-center gap-2.5">
                          <span
                            className={`material-symbols-outlined text-[19px] transition-colors ${
                              isActive ? 'text-[#ffdad3]' : 'text-[var(--color-botanical-subtle)] group-hover:text-[var(--color-accent)] dark:text-[#8a8078]'
                            }`}
                          >
                            {item.icon}
                          </span>
                          <span>{item.name}</span>
                        </div>
                        {isActive && (
                          <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-badge-bg)] animate-pulse"></span>
                        )}
                      </NavLink>
                    );
                  });
                })()}
              </nav>
            </div>
          ))}
        </div>
      </div>


      {/* Signed-in staff card — real identity, real role (OWNER / ADMINISTRATOR / HANDLER) */}
      <div className="px-3 pt-3 pb-1 bg-[var(--color-surface-low)]/80 backdrop-blur-sm dark:bg-[#1e1b18]/80">
        <div className="p-2.5 rounded-xl bg-[var(--color-surface-lowest)] shadow-sm flex items-center justify-between gap-2 dark:bg-[#26221e]">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-8 h-8 rounded-full bg-[var(--color-btn)] text-white flex items-center justify-center font-semibold text-[12px] shrink-0">
              {(session?.name || 'SA').split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase()}
            </div>
            <div className="flex flex-col min-w-0">
              <span className="text-[12px] font-semibold text-[var(--color-botanical-text)] truncate dark:text-[#f0ede9]">
                {session?.name || 'Staff Member'}
              </span>
              <span className="flex items-center gap-1.5">
                <span
                  className={`inline-block px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider ${
                    session?.isOwner
                      ? 'bg-[var(--color-btn)] text-white'
                      : session?.role === 'admin'
                        ? 'bg-[var(--color-badge-bg)] text-[var(--color-badge-fg-strong)]'
                        : 'bg-[var(--color-surface-high)] text-[var(--color-botanical-text)] dark:bg-[#37332c] dark:text-[#f0ede9]'
                  }`}
                >
                  {session?.roleLabel || (session?.role === 'admin' ? 'Administrator' : session?.role === 'handler' ? 'Handler' : 'Staff')}
                </span>
                {session?.staffId && (
                  <span className="text-[9px] font-mono text-[var(--color-botanical-subtle)] truncate dark:text-[#8a8078]">
                    {session.staffId}
                  </span>
                )}
              </span>
              {/* Phase 22.4 — DISPLAY-ONLY workspace context: which business
                  this console belongs to (name + public /shops/ address).
                  Presentation only; membership is re-derived server-side. */}
              {session?.workspace?.slug && (
                <span className="flex items-center gap-1 mt-0.5 min-w-0">
                  <span className="material-symbols-outlined text-[11px] text-[var(--color-accent)] shrink-0" aria-hidden="true">storefront</span>
                  <span className="text-[10px] font-semibold text-[var(--color-botanical-muted)] truncate dark:text-[#b8b0a8]">
                    {session.workspace.name || session.workspace.slug}
                  </span>
                  <span className="text-[9px] font-mono text-[var(--color-botanical-subtle)] truncate dark:text-[#8a8078]">
                    /{session.workspace.slug}
                  </span>
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Bottom Actions */}
      <div className="px-3 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] md:pb-3 border-t border-[var(--color-botanical-border)] space-y-1 bg-[var(--color-surface-low)]/80 backdrop-blur-sm relative dark:bg-[#1e1b18]/80 dark:border-[#3a3530]">
        <Link
          to="/"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-between px-2.5 py-2 min-h-[44px] md:min-h-0 rounded-xl text-[13px] font-medium text-[var(--color-botanical-muted)] hover:bg-[var(--color-surface-high)] hover:text-[var(--color-botanical-text)] hover:-translate-y-0.5 transition-all duration-300 dark:text-[#b8b0a8] dark:hover:bg-[#33302a] dark:hover:text-[#f0ede9]"
        >
          <span className="flex items-center gap-2.5">
            <span className="material-symbols-outlined text-[18px]">storefront</span>
            <span>View Store</span>
          </span>
          <span className="material-symbols-outlined text-[16px] text-[var(--color-botanical-subtle)] dark:text-[#8a8078]">open_in_new</span>
        </Link>
        <button
          type="button"
          onClick={handleSignOut}
          className="w-full flex items-center gap-2.5 px-2.5 py-2 min-h-[44px] md:min-h-0 rounded-xl text-[13px] font-medium text-[var(--color-botanical-muted)] hover:text-[var(--color-danger)] hover:bg-[#ffdad6]/40 hover:-translate-y-0.5 transition-all duration-300 dark:text-[#b8b0a8] dark:hover:bg-[#ba1a1a]/10"
        >
          <span className="material-symbols-outlined text-[18px]">logout</span>
          <span>Sign Out</span>
        </button>
      </div>
    </div>
  );

  // Body scroll lock and Escape key for mobile drawer
  React.useEffect(() => {
    if (!isOpen) return undefined;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e) => {
      if (e.key === 'Escape' && onClose) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [isOpen, onClose]);

  return (
    <>
      {/* Desktop Persistent Sidebar */}
      <aside className="hidden md:flex flex-col fixed left-0 top-0 h-full w-[260px] z-30 shadow-[4px_0_24px_-8px_rgba(46,36,30,0.08)]">
        {sidebarContent}
      </aside>

      {/* Mobile Drawer Navigation */}
      {isOpen && (
        <div className="md:hidden fixed inset-0 z-50 flex">
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-black/40 backdrop-blur-xs transition-opacity"
            onClick={onClose}
          />
          {/* Drawer — capped at 86vw so the page edge stays visible, full
              dynamic viewport height so dynamic browser toolbars cannot clip
              the sign-out action at the bottom of the drawer. */}
          <div className="relative w-[280px] max-w-[86vw] h-dvh shadow-2xl z-10 animate-slide-in">
            {sidebarContent}
          </div>
        </div>
      )}
    </>
  );
}
