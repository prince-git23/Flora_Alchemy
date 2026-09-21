import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Search, Heart, ShoppingBag, User, Menu, X, ChevronDown, Gift, Sparkles, ArrowRight, Sun, Moon } from 'lucide-react';
import { useStore } from '../context/StoreContext.jsx';
import { useTheme } from '../context/ThemeContext.jsx';
import { getActiveCustomer } from '../services/customerService.js';
import SearchOverlay from './SearchOverlay.jsx';
import NotificationBell from './NotificationBell.jsx';

const SHOP_ITEMS = [
  { label: 'All Gifts', to: '/shop' },
  { label: 'Flowers & Bouquets', to: '/shop?category=bouquets' },
  { label: 'Handmade Cards', to: '/shop?category=cards' },
  { label: 'Charms & Keepsakes', to: '/shop?category=charms' },
  { label: 'Hampers', to: '/shop?category=hampers' },
  { label: 'Custom Gifts', to: '/custom-gifts' },
];

/**
 * Accessible desktop dropdown.
 *
 * Interaction model:
 *  — Hover opens (with gap-safe bridge so moving trigger→dropdown stays open).
 *  — Click toggles and "pins" the dropdown (mouse-leave does NOT close it).
 *  — Escape, outside click, or route change always closes.
 *  — Arrow keys navigate items; Home/End jump to first/last.
 */
function NavMenu({ label, items, isActive, variant = 'list' }) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const containerRef = useRef(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const leaveTimer = useRef(null);
  const itemRefs = useRef([]);

  useEffect(() => {
    if (!open) return undefined;
    const onDocClick = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
        setPinned(false);
      }
    };
    const onDocKey = (e) => {
      if (e.key === 'Escape') {
        setOpen(false);
        setPinned(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onDocKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onDocKey);
    };
  }, [open]);

  const handleMouseEnter = () => {
    clearTimeout(leaveTimer.current);
    leaveTimer.current = null;
    setOpen(true);
  };

  const handleMouseLeave = () => {
    if (pinned) return;
    leaveTimer.current = setTimeout(() => {
      setOpen(false);
      leaveTimer.current = null;
    }, 150);
  };

  useEffect(() => () => clearTimeout(leaveTimer.current), []);

  const handleTriggerClick = () => {
    if (open && pinned) {
      setOpen(false);
      setPinned(false);
    } else {
      setOpen(true);
      setPinned(true);
      clearTimeout(leaveTimer.current);
      leaveTimer.current = null;
    }
  };

  const handleMenuKeyDown = (e) => {
    const count = items.length;
    if (!count) return;
    const focused = document.activeElement;
    const idx = itemRefs.current.indexOf(focused);
    let next = -1;
    if (e.key === 'ArrowDown') { e.preventDefault(); next = idx < count - 1 ? idx + 1 : 0; }
    else if (e.key === 'ArrowUp') { e.preventDefault(); next = idx > 0 ? idx - 1 : count - 1; }
    else if (e.key === 'Home') { e.preventDefault(); next = 0; }
    else if (e.key === 'End') { e.preventDefault(); next = count - 1; }
    else if (e.key === 'Tab') { setOpen(false); setPinned(false); return; }
    if (next >= 0 && itemRefs.current[next]) itemRefs.current[next].focus();
  };

  return (
    <div ref={containerRef} className="relative" onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={handleTriggerClick}
        onKeyDown={(e) => { if (e.key === 'ArrowDown' && open) { e.preventDefault(); itemRefs.current[0]?.focus(); } }}
        className={`relative flex items-center gap-1 px-4 py-2 rounded-full text-[13px] font-semibold tracking-wide transition-all duration-200 ${
          isActive ? 'bg-[#ebe8e3] text-[var(--color-botanical-text)]' : 'text-[var(--color-botanical-muted)] hover:text-[var(--color-botanical-text)] hover:bg-[var(--color-surface-container)]'
        }`}
      >
        {label}
        <ChevronDown className={`w-3.5 h-3.5 transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
        {/* Active indicator bar */}
        <span className={`absolute -bottom-1 left-1/2 -translate-x-1/2 h-[2px] rounded-full bg-[#964735] transition-all duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${isActive || open ? 'w-4/5 opacity-100' : 'w-0 opacity-0'}`} />
      </button>

      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={label}
          onKeyDown={handleMenuKeyDown}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          className="absolute left-0 top-full pt-2 bg-[var(--color-surface-lowest)] rounded-2xl shadow-xl border border-[var(--color-botanical-border)] p-2 z-50 min-w-[200px] dark:bg-[#1e1b18] dark:border-[#3a3530]"
          style={{ animation: 'fadeIn 0.18s cubic-bezier(0.22, 1, 0.36, 1) forwards' }}
        >
          <div className={variant === 'grid' ? 'grid grid-cols-2 gap-1' : 'flex flex-col'}>
            {items.map((item, i) => (
              <Link
                key={item.to + item.label}
                ref={(el) => { itemRefs.current[i] = el; }}
                to={item.to}
                role="menuitem"
                tabIndex={-1}
                onClick={() => { setOpen(false); setPinned(false); }}
                className="flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl text-[13px] font-medium text-[var(--color-botanical-muted)] hover:text-[var(--color-botanical-text)] hover:bg-[var(--color-surface-low)] focus:bg-[var(--color-surface-low)] focus:text-[var(--color-botanical-text)] focus:outline-none transition-all duration-150 group dark:text-[#b8b0a8] dark:hover:text-[#f0ede9] dark:hover:bg-[#222019]"
                style={{ animationDelay: `${i * 30}ms` }}
              >
                {item.icon && <span aria-hidden="true" className="transition-transform duration-200 group-hover:scale-110">{item.icon}</span>}
                <span>{item.label}</span>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function Navbar() {
  const location = useLocation();
  const { cartCount, cartSubtotal, wishlist } = useStore();
  const { isDark, setMode } = useTheme();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [mobileDrawerReady, setMobileDrawerReady] = useState(false);
  const drawerPanelRef = useRef(null);
  const firstLinkRef = useRef(null);
  const closeTimerRef = useRef(null);

  const activeCustomer = getActiveCustomer();
  const isAuthed = !!activeCustomer;

  const isActive = (path) => {
    const base = path.split('?')[0];
    if (base === '/' && location.pathname === '/') return true;
    if (base !== '/' && location.pathname.startsWith(base)) return true;
    return false;
  };

  // Close mobile menu on route change
  useEffect(() => {
    setMobileMenuOpen(false);
    setSearchOpen(false);
    setMobileDrawerReady(false);
  }, [location.pathname, location.search]);

  // Scroll compression: shrink navbar on scroll
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 40);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Cmd+K search shortcut
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && String(e.key).toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Body scroll lock, Escape-to-close, focus management for mobile drawer
  useEffect(() => {
    if (!mobileMenuOpen) {
      // Restore scroll on close
      requestAnimationFrame(() => {
        setMobileDrawerReady(false);
      });
      return undefined;
    }

    // Lock body scroll
    const prevOverflow = document.body.style.overflow;
    const prevPos = window.scrollY;
    document.body.style.overflow = 'hidden';
    document.body.style.position = 'fixed';
    document.body.style.top = `-${prevPos}px`;
    document.body.style.width = '100%';

    // Focus first link after drawer animation
    closeTimerRef.current = setTimeout(() => {
      setMobileDrawerReady(true);
      firstLinkRef.current?.focus();
    }, 50);

    const onKey = (e) => {
      if (e.key === 'Escape') {
        setMobileMenuOpen(false);
      }
      // Trap focus inside drawer
      if (e.key === 'Tab' && drawerPanelRef.current) {
        const focusable = drawerPanelRef.current.querySelectorAll('a, button, input, [tabindex]:not([tabindex="-1"])');
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    window.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(closeTimerRef.current);
      document.body.style.overflow = prevOverflow;
      document.body.style.position = '';
      document.body.style.top = '';
      document.body.style.width = '';
      window.scrollTo(0, prevPos);
      window.removeEventListener('keydown', onKey);
    };
  }, [mobileMenuOpen]);

  const closeMobileMenu = useCallback(() => {
    setMobileMenuOpen(false);
  }, []);

  const mobileNavLinks = [
    { label: 'Shop', to: '/shop', emoji: '🛍️' },
    { label: 'Flowers & Bouquets', to: '/shop?category=bouquets', emoji: '🌸' },
    { label: 'Handmade Cards', to: '/shop?category=cards', emoji: '💌' },
    { label: 'Charms & Keepsakes', to: '/shop?category=charms', emoji: '🧸' },
    { label: 'Hampers', to: '/shop?category=hampers', emoji: '🎁' },
  ];

  const mobileExploreLinks = [
    { label: 'Curated Collections', to: '/collections', emoji: '✨' },
    { label: 'Our Story', to: '/our-story', emoji: '📖' },
    { label: "How It's Made", to: '/how-its-made', emoji: '🔧' },
    { label: 'Our Creations', to: '/our-creations', emoji: '🎨' },
    { label: 'Request a Custom Creation', to: '/custom-request', emoji: '✨', accent: true },
  ];

  const utilityButton = 'relative flex items-center justify-center min-w-[36px] min-h-[36px] sm:min-w-0 sm:min-h-0 sm:px-3 sm:py-1.5 rounded-full bg-[var(--color-surface-container)] text-[var(--color-botanical-muted)] hover:text-[var(--color-botanical-text)] hover:bg-[var(--color-surface-high)] transition-all duration-200 touch-target dark:bg-[#2a2520] dark:text-[#b8b0a8] dark:hover:text-[#f0ede9] dark:hover:bg-[#33302a]';

  return (
    <>
      <header
        className={`sticky top-0 left-0 right-0 w-full z-50 fa-nav-transition border-b border-[var(--color-botanical-border)] ${
          scrolled
            ? 'bg-[var(--color-surface-bg)]/95 backdrop-blur-xl shadow-[0_2px_20px_rgba(0,0,0,0.12)]'
            : 'bg-[var(--color-surface-bg)]/80 backdrop-blur-md shadow-[0_1px_8px_rgba(0,0,0,0.06)]'
        } dark:bg-[#1a1714]/95 dark:border-[#3a3530]`}
      >
        <div className={`fa-nav-transition max-w-7xl mx-auto px-2 sm:px-4 lg:px-8 flex items-center justify-between gap-1.5 sm:gap-2 lg:gap-4 ${
          scrolled ? 'h-12 sm:h-14 lg:h-16' : 'h-14 sm:h-16 lg:h-20'
        }`}>
          {/* Brand Logo */}
          <Link to="/" className="flex items-center gap-1.5 sm:gap-2.5 lg:gap-3 group min-w-0" aria-label="Flora Alchemy home">
            <img
              loading="eager"
              decoding="async"
              src="/assets/images/flora-asset-27.jpg"
              alt=""
              className="w-auto object-contain transition-all duration-300 group-hover:scale-105 shrink-0"
              style={{ height: scrolled ? '20px' : '24px' }}
            />
            <span className={`font-serif tracking-tight font-medium text-[var(--color-botanical-text)] group-hover:text-[#964735] transition-all duration-300 truncate whitespace-nowrap dark:text-[#f0ede9] ${
              scrolled ? 'text-[15px] sm:text-[16px] lg:text-[18px]' : 'text-[17px] sm:text-[19px] lg:text-[22px]'
            }`}>
              Flora Alchemy
            </span>
          </Link>

          {/* Desktop Main Navigation */}
          <nav className="hidden lg:flex items-center gap-1" aria-label="Main">
            <NavMenu label="Shop" items={SHOP_ITEMS} isActive={isActive('/shop')} />
            <Link
              to="/custom-gifts"
              className={`relative px-4 py-2 rounded-full text-[13px] font-semibold tracking-wide transition-all duration-200 ${
                isActive('/custom-gifts') ? 'bg-[var(--color-surface-high)] text-[var(--color-botanical-text)] dark:bg-[#33302a] dark:text-[#f0ede9]' : 'text-[var(--color-botanical-muted)] hover:text-[var(--color-botanical-text)] hover:bg-[var(--color-surface-container)] dark:text-[#b8b0a8] dark:hover:text-[#f0ede9] dark:hover:bg-[#2a2520]'
              }`}
            >
              Custom Gifts
              <span className={`absolute -bottom-1 left-1/2 -translate-x-1/2 h-[2px] rounded-full bg-[#964735] transition-all duration-300 ${isActive('/custom-gifts') ? 'w-4/5 opacity-100' : 'w-0 opacity-0'}`} />
            </Link>
            <Link
              to="/gift-finder"
              className={`relative px-4 py-2 rounded-full text-[13px] font-semibold tracking-wide transition-all duration-200 ${
                isActive('/gift-finder') ? 'bg-[var(--color-surface-high)] text-[var(--color-botanical-text)] dark:bg-[#33302a] dark:text-[#f0ede9]' : 'text-[var(--color-botanical-muted)] hover:text-[var(--color-botanical-text)] hover:bg-[var(--color-surface-container)] dark:text-[#b8b0a8] dark:hover:text-[#f0ede9] dark:hover:bg-[#2a2520]'
              }`}
            >
              Gift Finder
              <span className={`absolute -bottom-1 left-1/2 -translate-x-1/2 h-[2px] rounded-full bg-[#964735] transition-all duration-300 ${isActive('/gift-finder') ? 'w-4/5 opacity-100' : 'w-0 opacity-0'}`} />
            </Link>
            <NavMenu
              label="Our Story"
              items={[
                { label: 'Our Story', to: '/our-story' },
                { label: "How It's Made", to: '/how-its-made' },
                { label: 'Our Creations', to: '/our-creations' },
              ]}
              isActive={isActive('/our-story') || isActive('/how-its-made') || isActive('/our-creations')}
            />
          </nav>

          {/* Action Utilities */}
          <div className="flex items-center gap-0.5 sm:gap-1.5 lg:gap-2.5 shrink-0">
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              className={`${utilityButton} group/search`}
              title="Search Flora Alchemy"
              aria-label="Search Flora Alchemy"
            >
              <Search className="w-4 h-4 text-[var(--color-botanical-muted)] group-hover/search:text-[var(--color-botanical-text)] transition-colors" aria-hidden="true" />
              <span className="text-[11px] font-bold uppercase tracking-widest text-[var(--color-botanical-muted)]/80 hidden lg:inline ml-1 group-hover/search:text-[var(--color-botanical-primary)] transition-colors">⌘K</span>
            </button>

            <button
              type="button"
              onClick={() => setMode(isDark ? 'light' : 'dark')}
              className="p-1.5 sm:p-2 rounded-full hover:bg-[var(--color-surface-container)] text-[var(--color-botanical-muted)] hover:text-[var(--color-botanical-text)] transition-all duration-200 flex items-center justify-center min-w-[32px] min-h-[32px] sm:min-w-[36px] sm:min-h-[36px]"
              title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
              aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {isDark ? <Sun className="w-4 h-4 sm:w-[18px] sm:h-[18px]" /> : <Moon className="w-4 h-4 sm:w-[18px] sm:h-[18px]" />}
            </button>

            <NotificationBell />

            <Link
              to="/wishlist"
              className="relative p-1.5 sm:p-2 rounded-full hover:bg-[var(--color-surface-container)] text-[var(--color-botanical-muted)] hover:text-[var(--color-botanical-text)] transition-all duration-200 flex items-center justify-center min-w-[32px] min-h-[32px] sm:min-w-[36px] sm:min-h-[36px] group/wish dark:hover:bg-[#2a2520] dark:text-[#b8b0a8] dark:hover:text-[#f0ede9]"
              title="Saved Gifts"
              aria-label="Saved Gifts"
            >
              <Heart className={`w-4 h-4 sm:w-[18px] sm:h-[18px] lg:w-5 lg:h-5 transition-transform duration-200 group-hover/wish:scale-110 ${wishlist.length > 0 ? 'text-[#964735]' : 'text-[var(--color-botanical-muted)] dark:text-[#b8b0a8]'}`} aria-hidden="true" />
              {wishlist.length > 0 && (
                <span className="absolute top-0.5 right-0.5 w-4 h-4 bg-[#964735] text-white rounded-full text-[9px] font-bold flex items-center justify-center leading-none">
                  {wishlist.length}
                </span>
              )}
            </Link>

            <Link
              to="/cart"
              className="relative flex items-center gap-1 sm:gap-1.5 px-2 sm:px-2.5 lg:px-3.5 py-1.5 rounded-full bg-[var(--color-surface-container)] hover:bg-[var(--color-surface-high)] text-[var(--color-botanical-text)] transition-all duration-200 min-h-[32px] sm:min-h-[36px] group/cart dark:bg-[#2a2520] dark:hover:bg-[#33302a] dark:text-[#f0ede9]"
              title="Shopping Bag"
              aria-label={`Shopping Bag, ${cartCount} items`}
            >
              <ShoppingBag className="w-4 h-4 text-[var(--color-botanical-text)] transition-transform duration-200 group-hover/cart:scale-110 dark:text-[#f0ede9]" aria-hidden="true" />
              <span className="text-[11px] sm:text-[12px] font-semibold whitespace-nowrap hidden md:inline">
                {cartCount} · ₹{cartSubtotal.toLocaleString('en-IN')}
              </span>
              <span className="text-[11px] sm:text-[12px] font-semibold md:hidden">
                {cartCount}
              </span>
            </Link>

            <Link
              to={isAuthed ? '/account' : '/login'}
              className="flex items-center gap-1 p-1 sm:pl-1.5 sm:pr-2 lg:pr-3 sm:py-1 rounded-full bg-[#180f0a] hover:bg-[#964735] text-white transition-all duration-200 min-w-[32px] min-h-[32px] justify-center"
              title={isAuthed ? 'My Account' : 'Sign In'}
              aria-label={isAuthed ? 'My Account' : 'Sign In'}
            >
              <span className="flex items-center justify-center w-6 h-6 rounded-full bg-[var(--color-surface-lowest)]/15 text-[11px] font-bold transition-transform duration-200 hover:scale-105">
                {isAuthed ? (activeCustomer.name || 'A').charAt(0).toUpperCase() : <User className="w-3.5 h-3.5" />}
              </span>
              <span className="text-[11px] font-semibold hidden lg:inline whitespace-nowrap">
                {isAuthed ? 'My Account' : 'Sign In'}
              </span>
            </Link>

            {/* Mobile menu button */}
            <button
              type="button"
              className="lg:hidden p-2 rounded-full hover:bg-[var(--color-surface-container)] text-[var(--color-botanical-text)] min-w-[40px] min-h-[40px] flex items-center justify-center transition-colors duration-200 dark:hover:bg-[#2a2520] dark:text-[#f0ede9]"
              onClick={() => setMobileMenuOpen((o) => !o)}
              aria-label={mobileMenuOpen ? 'Close menu' : 'Open menu'}
              aria-expanded={mobileMenuOpen}
              aria-controls="mobile-nav-drawer"
            >
              <span className="relative w-5 h-5">
                <Menu className={`absolute inset-0 w-5 h-5 transition-all duration-300 ${mobileMenuOpen ? 'rotate-90 opacity-0 scale-75' : 'rotate-0 opacity-100 scale-100'}`} />
                <X className={`absolute inset-0 w-5 h-5 transition-all duration-300 ${mobileMenuOpen ? 'rotate-0 opacity-100 scale-100' : '-rotate-90 opacity-0 scale-75'}`} />
              </span>
            </button>
          </div>
        </div>
      </header>

      {/* ═══════════════════════════════════════════════
          MOBILE NAVIGATION DRAWER — Spatial Transition
          ═══════════════════════════════════════════════ */}
      {mobileMenuOpen && (
        <div
          id="mobile-nav-drawer"
          className="lg:hidden fixed inset-0 z-[60]"
          role="dialog"
          aria-modal="true"
          aria-label="Navigation menu"
        >
          {/* Backdrop — covers everything including header */}
          <div
            className="fixed inset-0 bg-[#180f0a]/30 backdrop-blur-sm fa-drawer-backdrop dark:bg-black/50"
            onClick={closeMobileMenu}
            aria-hidden="true"
          />

          {/* Drawer Panel — slides from right, covers full height including header */}
          <div
            ref={drawerPanelRef}
            className={`fixed top-0 right-0 bottom-0 w-[min(85vw,380px)] bg-[var(--color-surface-bg)] shadow-[-8px_0_32px_rgba(0,0,0,0.2)] fa-drawer-slide overflow-y-auto overscroll-contain dark:bg-[#1a1714] ${
              mobileDrawerReady ? '' : ''
            }`}
          >
            {/* Drawer Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-botanical-border)] dark:border-[#3a3530]">
              <Link to="/" onClick={closeMobileMenu} className="flex items-center gap-2.5 group" aria-label="Flora Alchemy home">
                <img
                  loading="lazy"
                  decoding="async"
                  src="/assets/images/flora-asset-27.jpg"
                  alt=""
                  className="w-6 h-6 object-contain"
                />
                <span className="font-serif text-[18px] tracking-tight font-medium text-[var(--color-botanical-text)] group-hover:text-[#964735] transition-colors dark:text-[#f0ede9]">
                  Flora Alchemy
                </span>
              </Link>
              <button
                type="button"
                onClick={closeMobileMenu}
                className="p-2 rounded-full hover:bg-[var(--color-surface-container)] text-[var(--color-botanical-muted)] transition-colors touch-target dark:hover:bg-[#2a2520] dark:text-[#b8b0a8]"
                aria-label="Close menu"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Quick Actions Row */}
            <div className="px-5 py-4 border-b border-[var(--color-botanical-border)]">
              <div className="grid grid-cols-3 gap-2">
                <button
                  type="button"
                  onClick={() => { closeMobileMenu(); setTimeout(() => setSearchOpen(true), 200); }}
                  className="flex flex-col items-center justify-center gap-1.5 py-3 rounded-2xl bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] text-[11px] font-semibold text-[var(--color-botanical-muted)] hover:bg-[var(--color-surface-low)] transition-colors touch-target dark:bg-[#1e1b18] dark:border-[#3a3530] dark:text-[#b8b0a8] dark:hover:bg-[#222019]"
                >
                  <Search className="w-4 h-4" aria-hidden="true" /> Search
                </button>
                <Link
                  to="/wishlist"
                  onClick={closeMobileMenu}
                  className="flex flex-col items-center justify-center gap-1.5 py-3 rounded-2xl bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] text-[11px] font-semibold text-[var(--color-botanical-muted)] hover:bg-[var(--color-surface-low)] transition-colors touch-target dark:bg-[#1e1b18] dark:border-[#3a3530] dark:text-[#b8b0a8] dark:hover:bg-[#222019]"
                >
                  <Heart className="w-4 h-4" aria-hidden="true" /> Saved {wishlist.length > 0 ? `(${wishlist.length})` : ''}
                </Link>
                <Link
                  to="/cart"
                  onClick={closeMobileMenu}
                  className="flex flex-col items-center justify-center gap-1.5 py-3 rounded-2xl bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] text-[11px] font-semibold text-[var(--color-botanical-muted)] hover:bg-[var(--color-surface-low)] transition-colors touch-target dark:bg-[#1e1b18] dark:border-[#3a3530] dark:text-[#b8b0a8] dark:hover:bg-[#222019]"
                >
                  <ShoppingBag className="w-4 h-4" aria-hidden="true" /> Bag ({cartCount})
                </Link>
              </div>
            </div>

            {/* Shop Links */}
            <div className="px-5 py-4">
              <p className="text-[11px] uppercase font-bold tracking-widest text-[var(--color-botanical-subtle)] mb-3">Shop</p>
              <div className="space-y-1">
                {mobileNavLinks.map((link, i) => (
                  <Link
                    key={link.to + link.label}
                    ref={i === 0 ? firstLinkRef : undefined}
                    to={link.to}
                    onClick={closeMobileMenu}
                    className={`flex items-center gap-3 px-4 py-3 rounded-xl text-[14px] font-medium min-h-[44px] transition-all duration-200 ${
                      isActive(link.to.split('?')[0])
                        ? 'bg-[var(--color-surface-high)] text-[var(--color-botanical-text)] dark:bg-[#33302a] dark:text-[#f0ede9]'
                        : 'text-[var(--color-botanical-muted)] hover:bg-[var(--color-surface-low)] hover:text-[var(--color-botanical-text)] dark:text-[#b8b0a8] dark:hover:bg-[#222019] dark:hover:text-[#f0ede9]'
                    } ${mobileDrawerReady ? 'fa-drawer-link' : 'opacity-0'}`}
                    style={{ animationDelay: mobileDrawerReady ? `${80 + i * 40}ms` : '0ms' }}
                  >
                    <span className="text-base" aria-hidden="true">{link.emoji}</span>
                    <span>{link.label}</span>
                    <ArrowRight className="w-3.5 h-3.5 ml-auto text-[var(--color-botanical-subtle)] opacity-0 group-hover:opacity-100 transition-opacity" aria-hidden="true" />
                  </Link>
                ))}
              </div>
            </div>

            {/* Gifting Section */}
            <div className="px-5 py-4 border-t border-[var(--color-botanical-border)]">
              <p className="text-[11px] uppercase font-bold tracking-widest text-[var(--color-botanical-subtle)] mb-3">Gifting</p>
              <div className="space-y-2">
                <Link
                  to="/gift-finder"
                  onClick={closeMobileMenu}
                  className="flex items-center justify-between p-4 rounded-2xl bg-[#180f0a] text-white min-h-[48px] active:scale-[0.98] transition-transform"
                >
                  <span className="flex items-center gap-2 text-[13px] font-semibold">
                    <Gift className="w-4 h-4" aria-hidden="true" /> Gift Finder
                  </span>
                  <ArrowRight className="w-4 h-4" aria-hidden="true" />
                </Link>
                <Link
                  to="/custom-gifts"
                  onClick={closeMobileMenu}
                  className="flex items-center justify-between p-4 rounded-2xl bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] text-[var(--color-botanical-text)] min-h-[48px] active:scale-[0.98] transition-transform dark:bg-[#1e1b18] dark:border-[#3a3530] dark:text-[#f0ede9]"
                >
                  <span className="flex items-center gap-2 text-[13px] font-semibold">
                    <Sparkles className="w-4 h-4 text-[#964735]" aria-hidden="true" /> Custom Gift Studio
                  </span>
                  <ArrowRight className="w-4 h-4" aria-hidden="true" />
                </Link>
              </div>
            </div>

            {/* Explore Links */}
            <div className="px-5 py-4 border-t border-[var(--color-botanical-border)]">
              <p className="text-[11px] uppercase font-bold tracking-widest text-[var(--color-botanical-subtle)] mb-3">Explore</p>
              <div className="space-y-1">
                {mobileExploreLinks.map((link, i) => (
                  <Link
                    key={link.to + link.label}
                    to={link.to}
                    onClick={closeMobileMenu}
                    className={`flex items-center gap-3 px-4 py-3 rounded-xl text-[14px] font-medium min-h-[44px] transition-all duration-200 ${
                      link.accent
                        ? 'text-[#964735] hover:bg-[#ffdad3]/30'
                        : isActive(link.to)
                          ? 'bg-[#ebe8e3] text-[var(--color-botanical-text)]'
                          : 'text-[var(--color-botanical-muted)] hover:bg-[var(--color-surface-low)] hover:text-[var(--color-botanical-text)]'
                    }`}
                  >
                    <span className="text-base" aria-hidden="true">{link.emoji}</span>
                    <span>{link.label}</span>
                  </Link>
                ))}
              </div>
            </div>

            {/* Account Section */}
            <div className="px-5 py-4 border-t border-[var(--color-botanical-border)]">
              <Link
                to={isAuthed ? '/account' : '/login'}
                onClick={closeMobileMenu}
                className="flex items-center gap-3 text-[13px] font-semibold text-[#964735] py-2 min-h-[44px]"
              >
                <User className="w-4 h-4" aria-hidden="true" />
                <span>{isAuthed ? `My Account${activeCustomer ? ` — ${activeCustomer.name}` : ''}` : 'Sign In / Create Account'}</span>
              </Link>
            </div>

            {/* Bottom safe area padding */}
            <div className="h-6" />
          </div>
        </div>
      )}

      <SearchOverlay open={searchOpen} onClose={() => setSearchOpen(false)} />

      {/* Global keyframe for dropdown fade-in */}
      <style>{`@keyframes fadeIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }`}</style>
    </>
  );
}
