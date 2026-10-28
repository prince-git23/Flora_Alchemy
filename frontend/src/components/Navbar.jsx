import React, { useEffect, useRef, useState, useCallback, useMemo, Suspense, lazy } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Search, Heart, ShoppingBag, User, Menu, X, Gift, Sparkles, ArrowRight, Sun, Moon } from 'lucide-react';
import { useStore } from '../context/StoreContext.jsx';
import { useTheme } from '../context/ThemeContext.jsx';
import { getActiveCustomer } from '../services/customerService.js';
import NotificationBell from './NotificationBell.jsx';
import GooeyNav from './cinematic/GooeyNav.jsx';

/**
 * Phase 20.0 — the search overlay is split out of the entry bundle.
 *
 * It imports gsap, and because the navbar is part of the shell on every
 * storefront page, that animation library used to be downloaded, parsed and
 * executed by every visitor before the site became interactive — for an
 * overlay most visitors never open. The chunk is warmed up once the page is
 * idle (below), so opening search is still instant.
 */
const loadSearchOverlay = () => import('./SearchOverlay.jsx');
const SearchOverlay = lazy(loadSearchOverlay);

/**
 * Desktop primary navigation — React Bits GooeyNav items.
 *
 * Every href is a real route (never #): SPA navigation is handled by the
 * click-capture in the Navbar body, so the anchors stay real links for
 * assistive tech, copy-link and open-in-new-tab. Category shortcuts and the
 * Our Story family remain reachable from the mobile drawer, the footer and
 * the homepage collection/craft sections.
 */
const DESKTOP_NAV_ITEMS = [
  { label: 'Shop', href: '/shop' },
  { label: 'Collections', href: '/collections' },
  { label: 'Gift Finder', href: '/gift-finder' },
  { label: 'Custom Gifts', href: '/custom-gifts' }
];

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

  /**
   * Desktop primary nav — React Bits GooeyNav (see components/cinematic/).
   *
   * Mounted only at >=1024px (the accessible drawer serves smaller screens),
   * never under prefers-reduced-motion is NOT required here: GooeyNav
   * settles instantly on its own and falls back to CSS pills when WebGL2 is
   * unavailable, so the nav is fully usable either way. A negative active
   * index means "no active item": home, cart, product and account belong to
   * no navigation item and must not claim a false active state.
   */
  const navigate = useNavigate();
  const desktopNavRef = useRef(null);
  const [desktopNavEnabled, setDesktopNavEnabled] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const sync = () => setDesktopNavEnabled(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  const desktopNavActiveIndex = useMemo(() => {
    if (location.pathname === '/shop') return 0;
    if (location.pathname === '/collections') return 1;
    if (location.pathname === '/gift-finder') return 2;
    if (location.pathname === '/custom-gifts') return 3;
    return -1;
  }, [location.pathname]);

  /*
   * GooeyNav renders real anchors; this capture handler keeps SPA
   * navigation (no full reloads) while leaving modified clicks
   * (new tab, copy link) to the browser. It is the single navigation
   * path: GooeyNav is controlled, so its own select() is a no-op.
   */
  const handleDesktopNavClick = useCallback((event) => {
    const anchor = event.target instanceof Element ? event.target.closest('a[href^="/"]') : null;
    if (!anchor || !desktopNavRef.current?.contains(anchor)) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    navigate(anchor.getAttribute('href'));
  }, [navigate]);

  // Close mobile menu on route change
  useEffect(() => {
    setMobileMenuOpen(false);
    setSearchOpen(false);
    setMobileDrawerReady(false);
  }, [location.pathname, location.search]);

  // Warm the search-overlay chunk after the shell is interactive, so the
  // deferred gsap code never competes with first paint or the bootstrap
  // request and the first search still opens without a loading gap.
  useEffect(() => {
    let cancelled = false;
    const warm = () => {
      if (!cancelled) loadSearchOverlay().catch(() => {});
    };
    const supportsIdle = typeof window.requestIdleCallback === 'function';
    const id = supportsIdle
      ? window.requestIdleCallback(warm, { timeout: 2500 })
      : window.setTimeout(warm, 1200);
    return () => {
      cancelled = true;
      if (supportsIdle) window.cancelIdleCallback(id);
      else clearTimeout(id);
    };
  }, []);

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

  /*
   * Active state for the DRAWER's link rows. The drawer renders a plain <Link>
   * list (not NavLink), so the comparison is computed here. A row without a
   * query ("Shop") is active for its whole path — parent pages stay lit on a
   * filtered child; a row WITH a query ("Flowers & Bouquets" → /shop?category=…)
   * must match the search too, so /shop lights only the plain Shop row instead
   * of all five. Missing this helper threw
   * `ReferenceError: isActive is not defined` the moment the drawer mounted.
   */
  const isActive = (to) => {
    const [path, query] = to.split('?');
    if (path !== location.pathname) return false;
    return query ? `${location.pathname}${location.search}` === to : true;
  };

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
        }`}
      >
        <div className={`fa-nav-transition max-w-7xl mx-auto px-2 sm:px-4 lg:px-8 flex items-center justify-between gap-1.5 sm:gap-2 lg:gap-4 ${
          scrolled ? 'h-12 sm:h-14 lg:h-16' : 'h-14 sm:h-16 lg:h-20'
        }`}>
          {/* Brand Logo */}
          <Link to="/" className="flex items-center gap-1.5 sm:gap-2.5 lg:gap-3 group min-w-0" aria-label="Flora Alchemy home">
            <img
              loading="eager"
              decoding="async"
              src="/branding/flora-alchemy-logo.jpg"
              alt=""
              className="w-auto object-contain transition-all duration-300 group-hover:scale-105 shrink-0"
              style={{ height: scrolled ? '20px' : '24px' }}
            />
            <span className={`font-serif tracking-tight font-medium text-[var(--color-botanical-text)] group-hover:text-[var(--color-accent)] transition-all duration-300 truncate whitespace-nowrap dark:text-[#f0ede9] ${
              scrolled ? 'text-[15px] sm:text-[16px] lg:text-[18px]' : 'text-[17px] sm:text-[19px] lg:text-[22px]'
            }`}>
              Flora Alchemy
            </span>
          </Link>

          {/* Desktop Main Navigation — React Bits GooeyNav (real routes, SPA). */}
          {desktopNavEnabled && (
            <div className="hidden lg:flex items-center" ref={desktopNavRef} onClickCapture={handleDesktopNavClick}>
              <GooeyNav
                ariaLabel="Main"
                items={DESKTOP_NAV_ITEMS}
                activeIndex={desktopNavActiveIndex}
                size="sm"
                theme={isDark ? 'dark' : 'light'}
                color="#964735"
                spread={44}
                particleCount={12}
                style={{
                  '--gn-frame': isDark ? 'rgba(30, 25, 20, 0.72)' : 'rgba(255, 252, 247, 0.82)',
                  '--gn-frame-edge': isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(64, 38, 26, 0.10)'
                }}
              />
            </div>
          )}

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
              <Heart className={`w-4 h-4 sm:w-[18px] sm:h-[18px] lg:w-5 lg:h-5 transition-transform duration-200 group-hover/wish:scale-110 ${wishlist.length > 0 ? 'text-[var(--color-accent)]' : 'text-[var(--color-botanical-muted)] dark:text-[#b8b0a8]'}`} aria-hidden="true" />
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
              className="flex items-center gap-1 p-1 sm:pl-1.5 sm:pr-2 lg:pr-3 sm:py-1 rounded-full bg-[var(--color-btn)] hover:bg-[var(--color-btn-hover)] text-white transition-all duration-200 min-w-[32px] min-h-[32px] justify-center"
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
            ref={drawerPanelRef}             className={`fixed top-0 right-0 bottom-0 w-[min(85vw,380px)] bg-[var(--color-surface-bg)] shadow-[-8px_0_32px_rgba(0,0,0,0.2)] fa-drawer-slide overflow-y-auto overscroll-contain ${
              mobileDrawerReady ? '' : ''
            }`}
          >
            {/* Drawer Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-botanical-border)] dark:border-[#3a3530]">
              <Link to="/" onClick={closeMobileMenu} className="flex items-center gap-2.5 group" aria-label="Flora Alchemy home">
                <img
                  loading="lazy"
                  decoding="async"
                  src="/branding/flora-alchemy-logo.jpg"
                  alt=""
                  className="w-6 h-6 object-contain"
                />
                <span className="font-serif text-[18px] tracking-tight font-medium text-[var(--color-botanical-text)] group-hover:text-[var(--color-accent)] transition-colors dark:text-[#f0ede9]">
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
                      isActive(link.to)
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
                  className="flex items-center justify-between p-4 rounded-2xl bg-[var(--color-btn)] text-white min-h-[48px] active:scale-[0.98] transition-transform"
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
                    <Sparkles className="w-4 h-4 text-[var(--color-accent)]" aria-hidden="true" /> Custom Gift Studio
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
                        ? 'text-[var(--color-accent)] hover:bg-[var(--color-badge-bg)]/30'
                        : isActive(link.to)
                          ? 'bg-[var(--color-surface-high)] text-[var(--color-botanical-text)]'
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
                className="flex items-center gap-3 text-[13px] font-semibold text-[var(--color-accent)] py-2 min-h-[44px]"
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

      {searchOpen && (
        <Suspense fallback={null}>
          <SearchOverlay open={searchOpen} onClose={() => setSearchOpen(false)} />
        </Suspense>
      )}

      {/* Global keyframe for dropdown fade-in */}
      <style>{`@keyframes fadeIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }`}</style>
    </>
  );
}
