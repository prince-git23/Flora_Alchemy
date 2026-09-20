import React from 'react';
import { NavLink, useLocation, Link, useNavigate } from 'react-router-dom';
import { useAdminSession } from '../../context/AdminSessionContext.jsx';

export default function AdminSidebar({ isOpen, onClose }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { logout } = useAdminSession();

  const handleSignOut = () => {
    logout();
    navigate('/admin/login');
  };


  const navGroups = [
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
      group: 'COMMERCE',
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
        }
      ]
    },
    {
      group: 'OPERATIONS',
      items: [
        {
          name: 'Inventory',
          path: '/admin/inventory',
          icon: 'warehouse'
        },
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
        }
      ]
    },
    {
      group: 'SYSTEM',
      items: [
        {
          name: 'Settings',
          path: '/admin/settings',
          aliases: ['/admin/store-preferences', '/admin/settings/commerce', '/admin/settings/notifications', '/admin/access'],
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

  const sidebarContent = (
    <div className="h-full flex flex-col justify-between bg-[var(--color-surface-low)] border-r border-[var(--color-botanical-border)] select-none relative overflow-hidden dark:bg-[#1e1b18] dark:border-[#3a3530]">
      {/* Ambient depth glow */}          <div className="absolute -top-16 -right-16 w-48 h-48 rounded-full bg-[#ffdad3]/10 blur-3xl pointer-events-none dark:bg-[#964735]/5" />
      <div className="absolute bottom-24 -left-12 w-40 h-40 rounded-full bg-[#d8e7cd]/10 blur-3xl pointer-events-none dark:bg-[#5b6d54]/5" />
      <div className="flex flex-col flex-1 min-h-0 relative">
        {/* Brand Header */}
        <div className="h-16 px-4 flex items-center justify-between border-b border-[var(--color-botanical-border)]/70 bg-[var(--color-surface-low)]/80 backdrop-blur-sm dark:bg-[#1e1b18]/80 dark:border-[#3a3530]/70">
          <Link to="/admin/dashboard" className="flex items-center gap-2.5">
            {/* Custom Botanical Emblem */}
            <div className="w-8 h-8 rounded-full bg-[#180f0a] flex items-center justify-center text-white shadow-sm shrink-0">
              <span className="material-symbols-outlined text-[19px] text-[#ffdad3]">local_florist</span>
            </div>
            <div className="flex flex-col min-w-0">
              <span className="font-serif text-[18px] text-[var(--color-botanical-text)] font-medium leading-none tracking-tight dark:text-[#f0ede9]">
                Flora Alchemy
              </span>
              <span className="text-[9px] uppercase tracking-widest text-[#964735] font-bold mt-1">
                Handler Portal
              </span>
            </div>
          </Link>

          {/* Close button on mobile */}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="md:hidden p-1.5 rounded-lg text-[#4e4540] hover:bg-[#ebe8e3] transition-colors"
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
                {group.items.map((item) => {
                  const isActive =
                    location.pathname === item.path ||
                    (item.aliases && item.aliases.includes(location.pathname));

                  return (
                    <NavLink
                      key={item.name}
                      to={item.path}
                      onClick={onClose}
                      className={`group relative flex items-center justify-between px-2.5 py-2 rounded-xl text-[13px] font-medium transition-all duration-300 ${
                        isActive
                          ? 'bg-[#180f0a] text-white font-semibold shadow-md shadow-[#180f0a]/20 dark:bg-[#964735] dark:shadow-[#964735]/20'
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
                            isActive ? 'text-[#ffdad3]' : 'text-[var(--color-botanical-subtle)] group-hover:text-[#964735] dark:text-[#8a8078]'
                          }`}
                        >
                          {item.icon}
                        </span>
                        <span>{item.name}</span>
                      </div>
                      {isActive && (
                        <span className="w-1.5 h-1.5 rounded-full bg-[#ffdad3] animate-pulse"></span>
                      )}
                    </NavLink>
                  );
                })}
              </nav>
            </div>
          ))}
        </div>
      </div>


      {/* Bottom Actions */}
      <div className="p-3 border-t border-[var(--color-botanical-border)] space-y-1 bg-[var(--color-surface-low)]/80 backdrop-blur-sm relative dark:bg-[#1e1b18]/80 dark:border-[#3a3530]">
        <Link
          to="/"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-between px-2.5 py-2 rounded-xl text-[13px] font-medium text-[var(--color-botanical-muted)] hover:bg-[var(--color-surface-high)] hover:text-[var(--color-botanical-text)] hover:-translate-y-0.5 transition-all duration-300 dark:text-[#b8b0a8] dark:hover:bg-[#33302a] dark:hover:text-[#f0ede9]"
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
          className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-xl text-[13px] font-medium text-[var(--color-botanical-muted)] hover:text-[#ba1a1a] hover:bg-[#ffdad6]/40 hover:-translate-y-0.5 transition-all duration-300 dark:text-[#b8b0a8] dark:hover:bg-[#ba1a1a]/10"
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
          {/* Drawer */}
          <div className="relative w-[280px] max-w-[85vw] h-full shadow-2xl z-10 animate-slide-in">
            {sidebarContent}
          </div>
        </div>
      )}
    </>
  );
}
