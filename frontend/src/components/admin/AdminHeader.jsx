import React, { useState, useMemo, useRef, useEffect } from 'react';
import { useLocation, useNavigate, Link } from 'react-router-dom';
import { getOrders, formatINR } from '../../services/orderService.js';
import { getCustomers } from '../../services/customerService.js';
import { getProducts } from '../../services/productService.js';
import { getCollections } from '../../services/collectionService.js';
import { useAdminSession } from '../../context/AdminSessionContext.jsx';
import NotificationBell from './NotificationBell.jsx';

export default function AdminHeader({ onOpenMobileMenu }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { session, logout } = useAdminSession();
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const searchBoxRef = useRef(null);

  // Close dropdowns when clicking outside
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (searchBoxRef.current && !searchBoxRef.current.contains(e.target)) {
        setSearchFocused(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Grouped live search across orders, customers, products, collections
  const searchResults = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return null;

    const orders = getOrders()
      .filter(
        (o) =>
          String(o.id || '').toLowerCase().includes(q) ||
          String(o.customerName || o.customer?.name || '').toLowerCase().includes(q)
      )
      .slice(0, 4);

    const customers = getCustomers()
      .filter(
        (c) =>
          String(c.name || '').toLowerCase().includes(q) ||
          String(c.email || '').toLowerCase().includes(q)
      )
      .slice(0, 4);

    const products = getProducts()
      .filter(
        (p) =>
          String(p.name || '').toLowerCase().includes(q) ||
          String(p.categoryLabel || p.category || '').toLowerCase().includes(q)
      )
      .slice(0, 4);

    const collections = getCollections()
      .filter((c) => String(c.name || '').toLowerCase().includes(q))
      .slice(0, 4);

    if (!orders.length && !customers.length && !products.length && !collections.length) {
      return { empty: true };
    }
    return { orders, customers, products, collections };
  }, [searchQuery]);

  const goToResult = (path) => {
    setSearchQuery('');
    setSearchFocused(false);
    navigate(path);
  };

  const hasAnyResults = searchResults && !searchResults.empty;

  // Derive breadcrumbs based on pathname
  const getBreadcrumbs = () => {
    const path = location.pathname;
    if (path === '/admin' || path === '/admin/dashboard') {
      return { section: 'Console', current: 'Dashboard' };
    }
    if (path.startsWith('/admin/orders')) {
      return { section: 'Commerce', current: path.includes('/orders/') ? 'Order Details' : 'Orders' };
    }
    if (path.startsWith('/admin/products')) {
      return { section: 'Commerce', current: path.includes('/products/') ? 'Product Details' : 'Products' };
    }
    if (path.startsWith('/admin/collections')) {
      return { section: 'Commerce', current: path.includes('/collections/') ? 'Collection Details' : 'Collections' };
    }
    if (path.startsWith('/admin/customers')) {
      return { section: 'Operations', current: path.includes('/customers/') ? 'Customer Details' : 'Customers' };
    }
    if (path.startsWith('/admin/inventory/history')) {
      return { section: 'Operations', subsection: 'Inventory', current: 'History' };
    }
    if (path.startsWith('/admin/inventory')) {
      return { section: 'Operations', current: 'Inventory' };
    }
    if (path.startsWith('/admin/analytics/sales')) {
      return { section: 'Insights', subsection: 'Analytics', current: 'Sales & Revenue' };
    }
    if (path.startsWith('/admin/analytics/performance')) {
      return { section: 'Insights', subsection: 'Analytics', current: 'Performance' };
    }
    if (path.startsWith('/admin/analytics')) {
      return { section: 'Insights', current: 'Analytics' };
    }
    if (path === '/admin/conversations') {
      return { section: 'Operations', current: 'Conversations' };
    }
    if (path === '/admin/access') {
      return { section: 'System', subsection: 'Settings', current: 'Admin & Handler Access' };
    }
    if (path === '/admin/store-preferences') {
      return { section: 'System', subsection: 'Settings', current: 'Store Preferences' };
    }
    if (path === '/admin/settings/commerce') {
      return { section: 'System', subsection: 'Settings', current: 'Order & Commerce' };
    }
    if (path === '/admin/settings/notifications') {
      return { section: 'System', subsection: 'Settings', current: 'Notifications & Alerts' };
    }
    if (path === '/admin/settings') {
      return { section: 'System', subsection: 'Settings', current: 'General Settings' };
    }
    return { section: 'Console', current: 'Operations' };
  };

  const breadcrumbs = getBreadcrumbs();



  return (
    <header className="sticky top-0 z-30 h-16 bg-[#fcf9f4]/90 backdrop-blur-xl border-b border-[#e5e2dd] px-4 md:px-8 flex items-center justify-between gap-4 select-none">
      {/* Left Area: Mobile Menu button & Breadcrumbs */}
      <div className="flex items-center gap-3 min-w-0">
        <button
          type="button"
          onClick={onOpenMobileMenu}
          className="md:hidden p-2 rounded-xl text-[#4e4540] hover:bg-[#ebe8e3] transition-colors"
          aria-label="Open navigation menu"
        >
          <span className="material-symbols-outlined text-[22px]">menu</span>
        </button>

        <div className="flex items-center gap-1.5 text-[13px] text-[#4e4540] truncate">
          <span className="text-[#80756f]">{breadcrumbs.section}</span>
          <span className="text-[#d1c4bd]">/</span>
          {breadcrumbs.subsection && (
            <>
              <span className="text-[#80756f]">{breadcrumbs.subsection}</span>
              <span className="text-[#d1c4bd]">/</span>
            </>
          )}
          <span className="text-[#180f0a] font-semibold truncate">{breadcrumbs.current}</span>
        </div>

        {/* Live data badge */}
        <span className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-[#ffdad3] text-[#783020] text-[10px] font-bold tracking-wider shrink-0 shadow-xs">
          <span className="h-1.5 w-1.5 rounded-full bg-[#964735] animate-pulse"></span>
          Live data
        </span>
      </div>

      {/* Right Area: Search, Notifications, Profile */}
      <div className="flex items-center gap-3 md:gap-4 shrink-0">
        {/* Global Search Bar */}
        <div ref={searchBoxRef} className="relative hidden sm:flex items-center">
          <span className="material-symbols-outlined absolute left-3 text-[18px] text-[#80756f] pointer-events-none">
            search
          </span>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onFocus={() => setSearchFocused(true)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setSearchFocused(false);
            }}
            placeholder="Search orders, customers, products..."
            className="pl-9 pr-10 py-1.5 w-60 lg:w-72 bg-[#f6f3ee] text-[#1c1c19] text-[13px] rounded-full placeholder:text-[#80756f] focus:outline-none focus:bg-white focus:ring-1 focus:ring-[#180f0a] transition-all border border-transparent focus:border-[#e5e2dd]"
          />
          {!searchQuery && (
            <kbd className="absolute right-2.5 text-[10px] bg-[#e5e2dd] text-[#4e4540] px-1.5 py-0.5 rounded font-mono font-medium">
              ⌘K
            </kbd>
          )}

          {/* Grouped Results Dropdown */}
          {searchFocused && searchQuery.trim() && searchResults && (
            <div className="absolute right-0 top-10 w-[22rem] bg-white rounded-2xl shadow-xl border border-[#e5e2dd] z-50 animate-fade-in max-h-[26rem] overflow-y-auto">
              {searchResults.empty ? (
                <div className="p-5 text-center">
                  <p className="text-[13px] font-semibold text-[#180f0a]">No results for &ldquo;{searchQuery}&rdquo;</p>
                  <p className="text-[11px] text-[#80756f] mt-1">Try an order ID, customer name, or product name.</p>
                </div>
              ) : (
                <>
                  {searchResults.orders.length > 0 && (
                    <SearchGroup label="ORDERS" icon="receipt_long">
                      {searchResults.orders.map((o) => (
                        <SearchRow
                          key={o.id}
                          title={o.id}
                          subtitle={`${o.customerName || 'Customer'} · ${formatINR(o.total)}`}
                          onClick={() => goToResult(`/admin/orders/${o.id}`)}
                        />
                      ))}
                    </SearchGroup>
                  )}
                  {searchResults.customers.length > 0 && (
                    <SearchGroup label="CUSTOMERS" icon="person">
                      {searchResults.customers.map((c) => (
                        <SearchRow
                          key={c.id}
                          title={c.name}
                          subtitle={`${c.email} · ${c.orders || 0} orders`}
                          onClick={() => goToResult(`/admin/customers/${c.id}`)}
                        />
                      ))}
                    </SearchGroup>
                  )}
                  {searchResults.products.length > 0 && (
                    <SearchGroup label="PRODUCTS" icon="local_florist">
                      {searchResults.products.map((p) => (
                        <SearchRow
                          key={p.id}
                          title={p.name}
                          subtitle={`${p.categoryLabel || 'Product'} · ${formatINR(p.price)}`}
                          onClick={() => goToResult(`/admin/products/${p.id}`)}
                        />
                      ))}
                    </SearchGroup>
                  )}
                  {searchResults.collections.length > 0 && (
                    <SearchGroup label="COLLECTIONS" icon="collections_bookmark">
                      {searchResults.collections.map((c) => (
                        <SearchRow
                          key={c.id}
                          title={c.name}
                          subtitle={c.description || 'Collection'}
                          onClick={() => goToResult(`/admin/collections/${c.id}`)}
                        />
                      ))}
                    </SearchGroup>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        {/* Notification Bell */}
        <NotificationBell />

        {/* Separator */}
        <div className="h-6 w-px bg-[#e5e2dd] hidden sm:block"></div>

        {/* Handler Admin Profile */}
        <div className="relative">
          <button
            type="button"
            onClick={() => setShowProfileMenu(!showProfileMenu)}
            className="flex items-center gap-2 p-1 rounded-full hover:bg-[#f0ede9] transition-colors cursor-pointer"
          >
            <div className="w-8 h-8 rounded-full bg-[#180f0a] text-white flex items-center justify-center font-semibold text-[13px] shadow-sm">
              {(session?.name || 'HA').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()}
            </div>
            <div className="hidden lg:flex flex-col text-left leading-tight pr-1">
              <span className="text-[13px] font-semibold text-[#180f0a]">{session?.name || 'Handler'}</span>
              <span className="text-[10px] text-[#80756f] capitalize">{session?.role || 'handler'}</span>
            </div>
            <span className="material-symbols-outlined text-[18px] text-[#80756f]">
              {showProfileMenu ? 'expand_less' : 'expand_more'}
            </span>
          </button>

          {showProfileMenu && (
            <div className="absolute right-0 mt-2 w-56 bg-white rounded-2xl shadow-xl border border-[#e5e2dd] p-2 z-50 animate-fade-in text-[13px]">
              <div className="px-3 py-2 border-b border-[#f0ede9]">
                <p className="font-semibold text-[#180f0a]">{session?.name || 'Handler'}</p>
                <p className="text-[11px] text-[#80756f] font-mono">{session?.email || ''}</p>
              </div>
              <div className="py-1">
                <Link
                  to="/admin/access"
                  onClick={() => setShowProfileMenu(false)}
                  className="flex items-center gap-2 px-3 py-2 rounded-xl text-[#4e4540] hover:bg-[#f6f3ee] hover:text-[#180f0a]"
                >
                  <span className="material-symbols-outlined text-[17px]">shield</span>
                  <span>Roles & Permissions</span>
                </Link>
                <Link
                  to="/admin/store-preferences"
                  onClick={() => setShowProfileMenu(false)}
                  className="flex items-center gap-2 px-3 py-2 rounded-xl text-[#4e4540] hover:bg-[#f6f3ee] hover:text-[#180f0a]"
                >
                  <span className="material-symbols-outlined text-[17px]">tune</span>
                  <span>Display Preferences</span>
                </Link>
                <Link
                  to="/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 px-3 py-2 rounded-xl text-[#4e4540] hover:bg-[#f6f3ee] hover:text-[#180f0a]"
                >
                  <span className="material-symbols-outlined text-[17px]">storefront</span>
                  <span>Open Public Store</span>
                </Link>
              </div>
              <div className="pt-1 border-t border-[#f0ede9]">
                <button
                  type="button"
                  onClick={() => {
                    setShowProfileMenu(false);
                    logout();
                    navigate('/admin/login');
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-[#ba1a1a] hover:bg-[#ffdad6]/40"
                >
                  <span className="material-symbols-outlined text-[17px]">logout</span>
                  <span>Sign Out Session</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

function SearchGroup({ label, icon, children }) {
  return (
    <div className="py-1.5">
      <div className="px-3 pt-2 pb-1 flex items-center gap-1.5">
        <span className="material-symbols-outlined text-[13px] text-[#964735]">{icon}</span>
        <span className="text-[10px] font-bold tracking-widest text-[#80756f]">{label}</span>
      </div>
      <div className="divide-y divide-[#f6f3ee]">{children}</div>
    </div>
  );
}

function SearchRow({ title, subtitle, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left px-4 py-2.5 flex items-center justify-between gap-3 hover:bg-[#f6f3ee] transition-colors"
    >
      <div className="min-w-0">
        <p className="text-[13px] font-semibold text-[#180f0a] truncate">{title}</p>
        {subtitle && <p className="text-[11px] text-[#80756f] truncate">{subtitle}</p>}
      </div>
      <span className="material-symbols-outlined text-[16px] text-[#d1c4bd] shrink-0">chevron_right</span>
    </button>
  );
}
