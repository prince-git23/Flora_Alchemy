import React, { useState, useEffect, useRef } from 'react';
import { Link, useNavigate, Navigate } from 'react-router-dom';
import { User, Package, MapPin, Mail, Phone, Edit2, LogOut, Plus, Check, Trash2, Star, Heart, ShoppingBag, MessageSquare, Truck, ArrowRight, Settings, Bell, CheckCheck, Loader2 } from 'lucide-react';
import { Skeleton, SkeletonRow } from '../components/Skeleton.jsx';
import { getAccount, apiLogout, getActiveCustomerId, getActiveCustomer, updateCustomer, addAddress, updateAddress, deleteAddress } from '../services/customerService.js';
import { getOrdersByCustomer, getStatusLabel, formatDate, getCustomerFacingStatus } from '../services/orderService.js';
import { getConversations } from '../services/conversationService.js';
import { getMyCustomRequests } from '../services/customRequestService.js';
import { fetchNotifications, markNotificationRead, markAllNotificationsRead } from '../services/notificationService.js';
import { OrderStatusPill, RequestStatusPill } from '../components/StatusPill.jsx';
import { useStore } from '../context/StoreContext.jsx';

/* ── GSAP ── */
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
gsap.registerPlugin(ScrollTrigger);

const prefersReduced = typeof window !== 'undefined' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const EMPTY_ADDRESS = { label: 'Home', name: '', address: '', city: '', state: '', pincode: '', phone: '' };

export default function AccountPage() {
  const navigate = useNavigate();
  const { showToast, wishlist, addItemToCart, toggleWishlist } = useStore();
  const [account, setAccount] = useState(null);
  const [profile, setProfile] = useState(null);
  const [orders, setOrders] = useState([]);
  const [conversations, setConversations] = useState([]);
  const [customRequests, setCustomRequests] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [unreadNotifCount, setUnreadNotifCount] = useState(0);
  const [activeTab, setActiveTab] = useState('overview');
  const [loaded, setLoaded] = useState(false);

  // Profile editing
  const [profileForm, setProfileForm] = useState({ name: '', phone: '' });
  const [profileSaving, setProfileSaving] = useState(false);

  // Address editing
  const [editingId, setEditingId] = useState(null); // null | 'new' | address id
  const [addressForm, setAddressForm] = useState(EMPTY_ADDRESS);
  const [addressSaving, setAddressSaving] = useState(false);
  const [addressError, setAddressError] = useState('');

  const pageRef = useRef(null);
  const headerRef = useRef(null);
  const contentRef = useRef(null);

  useEffect(() => {
    async function load() {
      const acc = await getAccount();
      setAccount(acc);
      const live = getActiveCustomer();
      setProfile(live);
      setProfileForm({ name: (live && live.name) || (acc && acc.name) || '', phone: (live && live.phone) || (acc && acc.phone) || '' });
      const customerId = acc ? acc.customerId || acc.id : getActiveCustomerId();
      if (customerId) {
        const [ords, convs, reqs, notifData] = await Promise.all([
          getOrdersByCustomer(customerId),
          getConversations().catch(() => []),
          getMyCustomRequests().catch(() => []),
          fetchNotifications().catch(() => ({ notifications: [], unreadCount: 0 })),
        ]);
        setOrders(ords);
        setConversations(convs);
        setCustomRequests(reqs);
        setNotifications(notifData.notifications || []);
        setUnreadNotifCount(notifData.unreadCount ?? 0);
      }
      setLoaded(true);
    }
    load();
  }, []);

  /* ── GSAP entrance animations ── */
  useEffect(() => {
    if (prefersReduced || !loaded || !account || !pageRef.current) return;
    const ctx = gsap.context(() => {
      if (headerRef.current) {
        gsap.from(headerRef.current, {
          y: 30, opacity: 0, duration: 0.7, ease: 'power3.out',
        });
      }
      if (contentRef.current) {
        const sections = contentRef.current.querySelectorAll('[data-account-section]');
        if (sections.length) {
          gsap.from(sections, {
            y: 24, opacity: 0, duration: 0.6, ease: 'power3.out', stagger: 0.08,
            scrollTrigger: { trigger: contentRef.current, start: 'top 85%', once: true },
          });
        }
      }
    }, pageRef);
    return () => ctx.revert();
  }, [loaded, account, activeTab]);

  // Guests are sent to the sign-in page — the account is private.
  if (loaded && !account) {
    return <Navigate to="/login" replace />;
  }

  if (!account) {
    return (
      <div className="w-full min-h-[60vh] bg-[var(--color-surface-bg)] px-4 sm:px-6 lg:px-10 py-8">
        <div className="max-w-3xl mx-auto space-y-6">
          {/* Profile header skeleton */}
          <div className="bg-[var(--color-surface-lowest)] rounded-3xl p-6 sm:p-8 border border-[var(--color-botanical-border)]">
            <div className="flex items-center gap-4">
              <Skeleton className="w-14 h-14 rounded-full shrink-0" />
              <div className="space-y-2 flex-1">
                <Skeleton className="h-5 w-40 rounded-md" />
                <Skeleton className="h-3.5 w-56 rounded-md" />
              </div>
            </div>
          </div>
          {/* Tab skeleton */}
          <div className="flex gap-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-20 rounded-full" />
            ))}
          </div>
          {/* Content skeleton */}
          <div className="space-y-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <SkeletonRow key={i} className="bg-[var(--color-surface-lowest)] rounded-2xl border border-[var(--color-botanical-border)]" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  const displayName = (profile && profile.name) || account.name || '';
  const displayEmail = (profile && profile.email) || account.email || '';
  const displayPhone = (profile && profile.phone) || account.phone || '';
  const addresses = (profile && profile.addresses) || [];
  const defaultAddress = addresses.find((a) => a.isDefault) || addresses[0];

  const handleSignOut = async () => {
    await apiLogout();
    navigate('/');
  };

  const handleProfileSave = async (e) => {
    e.preventDefault();
    if (!profileForm.name || profileForm.name.trim().length < 2) {
      showToast('Please provide your full name.', 'error');
      return;
    }
    setProfileSaving(true);
    try {
      const customerId = account.customerId || account.id;
      const updated = await updateCustomer(customerId, {
        name: profileForm.name.trim(),
        phone: profileForm.phone.trim(),
      });
      setProfile(updated);
      showToast('Profile updated');
    } catch (err) {
      showToast(err.message || 'Profile could not be updated.', 'error');
    } finally {
      setProfileSaving(false);
    }
  };

  const startAddAddress = () => {
    setAddressForm(EMPTY_ADDRESS);
    setAddressError('');
    setEditingId('new');
  };

  const startEditAddress = (addr) => {
    setAddressForm({
      label: addr.label || 'Home',
      name: addr.name || '',
      address: addr.address || '',
      city: addr.city || '',
      state: addr.state || '',
      pincode: addr.pincode || '',
      phone: addr.phone || '',
      isDefault: !!addr.isDefault,
    });
    setAddressError('');
    setEditingId(addr._id || addr.id);
  };

  const cancelAddress = () => {
    setEditingId(null);
    setAddressForm(EMPTY_ADDRESS);
    setAddressError('');
  };

  const handleAddressSave = async (e) => {
    e.preventDefault();
    setAddressSaving(true);
    setAddressError('');
    try {
      let updated;
      if (editingId === 'new') {
        updated = await addAddress(addressForm);
      } else {
        updated = await updateAddress(editingId, addressForm);
      }
      setProfile(updated);
      setEditingId(null);
      setAddressForm(EMPTY_ADDRESS);
      showToast(editingId === 'new' ? 'Address saved' : 'Address updated');
    } catch (err) {
      setAddressError(err.message || 'Address could not be saved.');
    } finally {
      setAddressSaving(false);
    }
  };

  const handleSetDefault = async (addr) => {
    try {
      const updated = await updateAddress(addr._id || addr.id, { isDefault: true });
      setProfile(updated);
      showToast('Default address updated');
    } catch (err) {
      showToast(err.message || 'Could not update default address.', 'error');
    }
  };

  const handleDeleteAddress = async (addr) => {
    try {
      const updated = await deleteAddress(addr._id || addr.id);
      setProfile(updated);
      if (editingId === (addr._id || addr.id)) cancelAddress();
      showToast('Address removed');
    } catch (err) {
      showToast(err.message || 'Could not remove address.', 'error');
    }
  };

  const tabs = [
    { key: 'overview', label: 'Overview', icon: User },
    { key: 'orders', label: 'Orders', icon: Package, count: orders.length },
    { key: 'saved', label: 'Saved Gifts', icon: Heart, count: wishlist.length },
    { key: 'notifications', label: 'Activity', icon: Bell, count: unreadNotifCount > 0 ? unreadNotifCount : undefined },
    { key: 'addresses', label: 'Addresses', icon: MapPin, count: addresses.length },
    { key: 'profile', label: 'Profile', icon: Settings },
  ];

  const handleOpenNotification = async (n) => {
    if (!n.read) {
      // Optimistic read + rollback on failure (backend PATCH /notifications/:id/read).
      setNotifications((prev) => prev.map((x) => (x._id === n._id ? { ...x, read: true } : x)));
      setUnreadNotifCount((c) => Math.max(0, c - 1));
      try {
        const res = await markNotificationRead(n._id);
        if (res && typeof res.unreadCount === 'number') setUnreadNotifCount(res.unreadCount);
      } catch {
        setNotifications((prev) => prev.map((x) => (x._id === n._id ? { ...x, read: false } : x)));
        setUnreadNotifCount((c) => c + 1);
      }
    }
    if (n.link) navigate(n.link);
  };

  const handleMarkAllRead = async () => {
    try {
      await markAllNotificationsRead();
      setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
      setUnreadNotifCount(0);
    } catch {
      showToast('Could not mark notifications as read.', 'error');
    }
  };

  return (
    <div ref={pageRef} className="w-full bg-[var(--color-surface-bg)] min-h-screen py-6 lg:py-16 relative overflow-hidden">
      {/* Ambient glow orbs */}
      <div className="absolute top-0 right-0 w-96 h-96 rounded-full bg-[#ffdad3]/12 blur-3xl pointer-events-none" />
      <div className="absolute bottom-40 left-0 w-80 h-80 rounded-full bg-[#d8e7cd]/10 blur-3xl pointer-events-none" />

      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 relative">
        {/* Profile Header */}
        <div ref={headerRef} className="relative bg-[var(--color-surface-lowest)] rounded-3xl p-5 sm:p-8 border border-[var(--color-botanical-border)] shadow-sm mb-6 sm:mb-8 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 sm:gap-6 overflow-hidden">
          {/* Inner glow */}
          <div className="absolute -top-16 -right-16 w-48 h-48 rounded-full bg-[#ffdad3]/10 blur-3xl pointer-events-none" />
          <div className="flex items-center gap-4">
            <div className="relative w-16 h-16 rounded-full bg-[#180f0a] text-white flex items-center justify-center font-serif text-[24px] shadow-md">
              {displayName.charAt(0)}
            </div>
            <div className="space-y-1">
              <span className="text-[11px] font-bold uppercase tracking-widest text-[#964735]">
                Customer Profile
              </span>
              <h1 className="font-serif text-[28px] text-[var(--color-botanical-primary)] font-medium leading-tight">
                {displayName}
              </h1>
              <p className="text-[13px] text-[var(--color-botanical-subtle)]">
                {displayEmail}
              </p>
            </div>
          </div>

          <div className="relative flex items-center gap-3">
            <Link
              to="/shop"
              className="px-5 py-2 rounded-full bg-[var(--color-surface-low)] text-[var(--color-botanical-primary)] hover:bg-[var(--color-surface-highest)] text-[12px] font-semibold transition-all duration-300 hover:shadow-sm hover:-translate-y-0.5 active:translate-y-0"
            >
              Browse Catalog
            </Link>              <button
                  type="button"
                  onClick={handleSignOut}
                  className="px-4 py-2 rounded-full border border-[var(--color-botanical-border)] text-[var(--color-botanical-subtle)] hover:text-[var(--color-botanical-primary)] text-[12px] flex items-center gap-1.5 transition-all duration-300 hover:shadow-sm active:translate-y-0 touch-target"
                >
              <LogOut className="w-3.5 h-3.5" />
              <span>Sign Out</span>
            </button>
          </div>
        </div>

        {/* Tab Navigation — mobile: compact icon+label pills, desktop: serif tabs */}
        <div className="flex items-center gap-1.5 sm:gap-4 border-b border-[var(--color-botanical-border)] pb-4 mb-6 sm:mb-8 overflow-x-auto scrollbar-none">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-full text-[12px] sm:text-[14px] font-medium transition-all whitespace-nowrap shrink-0 ${
                  activeTab === tab.key
                    ? 'bg-[#180f0a] text-white shadow-sm'
                    : 'text-[var(--color-botanical-subtle)] hover:text-[var(--color-botanical-primary)] hover:bg-[var(--color-surface-low)]'
                }`}
              >
                <Icon className="w-3.5 h-3.5 sm:w-4 sm:h-4" aria-hidden="true" />
                <span className="hidden sm:inline">{tab.label}</span>
                {tab.count !== undefined && (
                  <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-bold ${
                    activeTab === tab.key ? 'bg-[var(--color-surface-lowest)]/20' : 'bg-[var(--color-surface-container)]'
                  }`}>
                    {tab.count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Overview Tab */}
        {activeTab === 'overview' && (
          <div ref={contentRef} className="space-y-8">
            {/* Welcome */}
            <div data-account-section className="relative bg-gradient-to-br from-[#180f0a] to-[#2e241e] rounded-3xl p-6 sm:p-8 text-white overflow-hidden">
              {/* Inner depth glow */}
              <div className="absolute -top-20 -right-20 w-60 h-60 rounded-full bg-[#964735]/10 blur-3xl pointer-events-none" />
              <div className="absolute -bottom-16 -left-16 w-48 h-48 rounded-full bg-[var(--color-surface-lowest)]/5 blur-3xl pointer-events-none" />
              <div className="relative flex items-center gap-4 mb-6">
                <div className="w-14 h-14 rounded-full bg-[var(--color-surface-lowest)]/15 flex items-center justify-center font-serif text-[22px] shadow-inner">
                  {displayName.charAt(0).toUpperCase()}
                </div>
                <div>
                  <h2 className="font-serif text-[24px] font-normal">Welcome back, {displayName.split(' ')[0] || 'there'}</h2>
                  <p className="text-[13px] text-white/60">{displayEmail}</p>
                </div>
              </div>
              <div className="relative grid grid-cols-2 sm:grid-cols-4 gap-3">
                <button type="button" onClick={() => orders[0] && navigate(`/order-tracking/${orders[0].id || orders[0].orderId}`)} disabled={orders.length === 0} className="flex items-center gap-3 p-3 rounded-2xl bg-[var(--color-surface-lowest)]/10 hover:bg-[var(--color-surface-lowest)]/15 transition-all duration-300 text-left disabled:opacity-40 hover:shadow-md hover:-translate-y-0.5 active:translate-y-0">
                  <div className="w-9 h-9 rounded-full bg-[var(--color-surface-lowest)]/10 flex items-center justify-center"><Package className="w-4 h-4 text-white" /></div>
                  <div className="min-w-0"><p className="text-[12px] font-semibold text-white">Track Order</p><p className="text-[11px] text-white/50 truncate">{orders.length > 0 ? `Latest: #${orders[0].id || orders[0].orderId}` : 'No orders yet'}</p></div>
                </button>
                <button type="button" onClick={() => setActiveTab('saved')} className="flex items-center gap-3 p-3 rounded-2xl bg-[var(--color-surface-lowest)]/10 hover:bg-[var(--color-surface-lowest)]/15 transition-all duration-300 text-left hover:shadow-md hover:-translate-y-0.5 active:translate-y-0">
                  <div className="w-9 h-9 rounded-full bg-[var(--color-surface-lowest)]/10 flex items-center justify-center"><Heart className="w-4 h-4 text-white" /></div>
                  <div className="min-w-0"><p className="text-[12px] font-semibold text-white">Saved Gifts</p><p className="text-[11px] text-white/50 truncate">{wishlist.length} saved</p></div>
                </button>
                <button type="button" onClick={() => setActiveTab('addresses')} className="flex items-center gap-3 p-3 rounded-2xl bg-[var(--color-surface-lowest)]/10 hover:bg-[var(--color-surface-lowest)]/15 transition-all duration-300 text-left hover:shadow-md hover:-translate-y-0.5 active:translate-y-0">
                  <div className="w-9 h-9 rounded-full bg-[var(--color-surface-lowest)]/10 flex items-center justify-center"><MapPin className="w-4 h-4 text-white" /></div>
                  <div className="min-w-0"><p className="text-[12px] font-semibold text-white">Addresses</p><p className="text-[11px] text-white/50 truncate">{defaultAddress ? `Default: ${defaultAddress.city}` : 'Add one'}</p></div>
                </button>
                <button type="button" onClick={() => { if (conversations.length > 0) { navigate(`/order/${conversations[0].orderId}/conversation`); } else { setActiveTab('orders'); } }} className="flex items-center gap-3 p-3 rounded-2xl bg-[var(--color-surface-lowest)]/10 hover:bg-[var(--color-surface-lowest)]/15 transition-all duration-300 text-left hover:shadow-md hover:-translate-y-0.5 active:translate-y-0">
                  <div className="w-9 h-9 rounded-full bg-[var(--color-surface-lowest)]/10 flex items-center justify-center"><MessageSquare className="w-4 h-4 text-white" /></div>
                  <div className="min-w-0"><p className="text-[12px] font-semibold text-white">Conversations</p><p className="text-[11px] text-white/50 truncate">{conversations.length > 0 ? `${conversations.length} thread${conversations.length > 1 ? 's' : ''}` : 'None yet'}</p></div>
                </button>
              </div>
            </div>

            {/* Recent Orders */}
            <section data-account-section>
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-serif text-[20px] text-[var(--color-botanical-primary)]">Recent Orders</h3>
                {orders.length > 3 && (
                  <button onClick={() => setActiveTab('orders')} className="text-[12px] font-semibold text-[#964735] hover:underline">View All →</button>
                )}
              </div>
              {orders.length === 0 ? (
                <div className="relative bg-[var(--color-surface-lowest)] rounded-3xl p-10 border border-[var(--color-botanical-border)] text-center space-y-3 overflow-hidden">
                  <div className="absolute -top-12 -right-12 w-36 h-36 rounded-full bg-[#ffdad3]/10 blur-3xl pointer-events-none" />
                  <p className="relative font-serif text-[18px] text-[var(--color-botanical-primary)]">No orders yet</p>
                  <p className="relative text-[13px] text-[var(--color-botanical-subtle)]">Your handcrafted floral orders will appear here.</p>
                  <Link to="/shop" className="relative inline-block px-6 py-2.5 rounded-full bg-[#180f0a] text-white text-[12px] font-semibold hover:bg-[#964735] transition-all duration-300 hover:shadow-lg hover:-translate-y-0.5 active:translate-y-0">Browse Gifts</Link>
                </div>
              ) : (
                <div className="space-y-3">
                  {orders.slice(0, 3).map((ord) => (
                    <div key={ord.id || ord.orderId} data-account-section className="bg-[var(--color-surface-lowest)] rounded-2xl p-4 border border-[var(--color-botanical-border)] shadow-xs flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:shadow-md transition-shadow duration-300">
                      <div className="flex items-center gap-3">
                        <span className="text-[13px] font-bold text-[var(--color-botanical-primary)]">#{ord.id || ord.orderId}</span>
                        <span className="text-[12px] text-[var(--color-botanical-subtle)]">{formatDate(ord.createdAt || ord.date)}</span>
                        <span className="px-2.5 py-1 rounded-full bg-[#ffdad3]/60 text-[#964735] text-[11px] font-bold uppercase">{getCustomerFacingStatus(ord.orderStatus || ord.status || 'new')}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[13px] font-bold text-[var(--color-botanical-primary)]">₹{ord.total?.toLocaleString('en-IN')}</span>
                        <button type="button" onClick={() => navigate(`/order-tracking/${ord.id || ord.orderId}`)} className="px-3 py-1.5 rounded-full bg-[#180f0a] text-white text-[11px] font-semibold hover:bg-[#964735] transition-all duration-300 flex items-center gap-1 hover:shadow-md"><Truck className="w-3 h-3" /> Track</button>
                        <Link to={`/order/${ord.id || ord.orderId}/conversation`} className="px-3 py-1.5 rounded-full border border-[var(--color-botanical-border)] text-[var(--color-botanical-muted)] text-[11px] font-semibold hover:bg-[var(--color-surface-low)] transition-all duration-300 flex items-center gap-1"><MessageSquare className="w-3 h-3" /> Message</Link>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* Notifications Snapshot */}
            <section data-account-section>
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-serif text-[20px] text-[var(--color-botanical-primary)]">Studio Updates</h3>
                <Link to="/notifications" className="text-[12px] font-semibold text-[#964735] hover:underline">View All →</Link>
              </div>
              {notifications.length === 0 ? (
                <div className="bg-[var(--color-surface-lowest)] rounded-3xl p-8 border border-[var(--color-botanical-border)] text-center space-y-2">
                  <p className="text-[14px] text-[var(--color-botanical-subtle)]">No updates yet. Order and request news will appear here.</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {notifications.slice(0, 3).map((n) => (
                    <button
                      key={n._id}
                      type="button"
                      onClick={() => handleOpenNotification(n)}
                      className={`w-full text-left flex items-start gap-3 bg-[var(--color-surface-lowest)] rounded-2xl p-4 border transition-all duration-300 ${!n.read ? 'border-[#c17c74]/40 shadow-sm hover:shadow-md' : 'border-[var(--color-botanical-border)] hover:shadow-sm'}`}
                    >
                      <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${!n.read ? 'bg-[#964735]' : 'bg-[#d9d3cc]'}`} aria-label={n.read ? 'Read' : 'Unread'} />
                      <span className="min-w-0 flex-1">
                        <span className={`block text-[13px] leading-snug ${!n.read ? 'font-semibold text-[var(--color-botanical-primary)]' : 'text-[var(--color-botanical-muted)]'}`}>{n.title}</span>
                        <span className="block text-[11px] text-[var(--color-botanical-subtle)] mt-0.5 line-clamp-1">{n.message}</span>
                      </span>
                      <ArrowRight className="w-4 h-4 text-[#b0a89f] shrink-0 mt-0.5" />
                    </button>
                  ))}
                </div>
              )}
            </section>

            {/* Conversations */}
            <section data-account-section>
              <h3 className="font-serif text-[20px] text-[var(--color-botanical-primary)] mb-4">Recent Conversations</h3>
              {conversations.length === 0 ? (
                <div className="bg-[var(--color-surface-lowest)] rounded-3xl p-8 border border-[var(--color-botanical-border)] text-center space-y-2">
                  <p className="text-[14px] text-[var(--color-botanical-subtle)]">No conversations yet. Message Flora Alchemy from any order page.</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {conversations.slice(0, 3).map((conv) => (
                    <Link key={conv._id || conv.id} to={`/order/${conv.orderId}/conversation`} className="flex items-center justify-between bg-[var(--color-surface-lowest)] rounded-2xl p-4 border border-[var(--color-botanical-border)] hover:border-[#c17c74] hover:shadow-md transition-all duration-300">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-full bg-[#ffdad3]/50 flex items-center justify-center"><MessageSquare className="w-4 h-4 text-[#964735]" /></div>
                        <div>
                          <p className="text-[13px] font-semibold text-[var(--color-botanical-primary)]">Order #{conv.orderId}</p>
                          <p className="text-[11px] text-[var(--color-botanical-subtle)]">{conv.lastMessageAt ? `Last message ${new Date(conv.lastMessageAt).toLocaleDateString()}` : 'No messages yet'}</p>
                        </div>
                      </div>
                      <ArrowRight className="w-4 h-4 text-[var(--color-botanical-subtle)]" />
                    </Link>
                  ))}
                </div>
              )}
            </section>

            {/* Custom Requests */}
            <section data-account-section>
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-serif text-[20px] text-[var(--color-botanical-primary)]">My Custom Requests</h3>
                <Link to="/custom-request" className="text-[12px] font-semibold text-[#964735] hover:underline">New Request →</Link>
              </div>
              {customRequests.length === 0 ? (
                <div className="bg-[var(--color-surface-lowest)] rounded-3xl p-8 border border-[var(--color-botanical-border)] text-center space-y-2">
                  <p className="text-[14px] text-[var(--color-botanical-subtle)]">No custom requests yet. Ask our studio for something one-of-a-kind.</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {customRequests.slice(0, 3).map((req) => (
                    <div key={req._id || req.id} className="bg-[var(--color-surface-lowest)] rounded-2xl p-4 border border-[var(--color-botanical-border)] flex flex-col sm:flex-row sm:items-center justify-between gap-2 hover:shadow-md transition-shadow duration-300">
                      <div className="min-w-0">
                        <p className="text-[13px] font-semibold text-[var(--color-botanical-primary)] line-clamp-1">{req.description}</p>
                        <p className="text-[11px] text-[var(--color-botanical-subtle)]">Submitted {new Date(req.createdAt).toLocaleDateString()}{req.occasion ? ` · ${req.occasion}` : ''}</p>
                      </div>
                      <RequestStatusPill status={req.status} className="self-start sm:self-auto" />
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* Quick Actions */}
            <section data-account-section className="relative bg-[var(--color-surface-low)] rounded-3xl p-6 border border-[var(--color-botanical-border)] overflow-hidden">
              <div className="absolute -bottom-10 -right-10 w-32 h-32 rounded-full bg-[#d8e7cd]/15 blur-2xl pointer-events-none" />
              <h3 className="relative font-serif text-[18px] text-[var(--color-botanical-primary)] mb-3">Need another gift?</h3>
              <div className="relative flex flex-wrap gap-3">
                <Link to="/shop" className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-[#180f0a] text-white text-[12px] font-semibold hover:bg-[#964735] transition-all duration-300 hover:shadow-md hover:-translate-y-0.5 active:translate-y-0"><ShoppingBag className="w-3.5 h-3.5" /> Browse Gifts</Link>
                <Link to="/gift-finder" className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] text-[var(--color-botanical-primary)] text-[12px] font-semibold hover:bg-[var(--color-surface-low)] transition-all duration-300 hover:shadow-sm hover:-translate-y-0.5 active:translate-y-0">Find a Gift</Link>
                <Link to="/custom-gifts" className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] text-[var(--color-botanical-primary)] text-[12px] font-semibold hover:bg-[var(--color-surface-low)] transition-all duration-300 hover:shadow-sm hover:-translate-y-0.5 active:translate-y-0">Custom Gift Studio</Link>
              </div>
            </section>
          </div>
        )}

        {/* Orders Tab */}
        {activeTab === 'orders' && (
          <div ref={contentRef} className="space-y-6">
            {orders.length === 0 ? (
              <div data-account-section className="relative bg-[var(--color-surface-lowest)] rounded-3xl p-10 border border-[var(--color-botanical-border)] text-center space-y-3 overflow-hidden">
                <div className="absolute -top-12 -right-12 w-36 h-36 rounded-full bg-[#ffdad3]/10 blur-3xl pointer-events-none" />
                <p className="relative font-serif text-[20px] text-[var(--color-botanical-primary)]">No orders placed yet</p>
                <p className="relative text-[13px] text-[var(--color-botanical-subtle)]">Your handcrafted floral orders will appear here once placed.</p>
                <div className="relative pt-2">
                  <Link to="/shop" className="inline-block px-6 py-2.5 rounded-full bg-[#180f0a] text-white text-[12px] font-semibold hover:bg-[#964735] transition-all duration-300 hover:shadow-lg hover:-translate-y-0.5 active:translate-y-0">
                    Explore Handcrafted Blooms
                  </Link>
                </div>
              </div>
            ) : (
              orders.map((ord) => (
                <div key={ord.id || ord.orderId} data-account-section className="bg-[var(--color-surface-lowest)] rounded-3xl p-6 border border-[var(--color-botanical-border)] shadow-xs space-y-4 hover:shadow-md transition-shadow duration-300">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-[var(--color-botanical-border)] pb-4">
                    <div>
                      <span className="text-[12px] font-bold text-[var(--color-botanical-primary)]">Order #{ord.id || ord.orderId}</span>
                      <span className="text-[12px] text-[var(--color-botanical-subtle)] ml-3">{formatDate(ord.createdAt || ord.date)}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="px-3 py-1 rounded-full bg-[#ffdad3] text-[#964735] text-[11px] font-bold uppercase">
                        {getStatusLabel(ord.orderStatus || ord.status || 'new')}
                      </span>
                      <Link
                        to={`/order-tracking/${ord.id || ord.orderId}`}
                        className="text-[12px] font-bold text-[var(--color-botanical-primary)] hover:text-[#964735] underline"
                      >
                        Track Dispatch →
                      </Link>
                    </div>
                  </div>

                  <div className="divide-y divide-[#e5e2dd] space-y-3">
                    {ord.items.map((item, idx) => (
                      <div key={idx} className="pt-3 first:pt-0 flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <img
                            loading="lazy"
                            decoding="async" src={item.image} alt={item.name} className="w-14 h-14 rounded-xl object-cover border border-[var(--color-botanical-border)]" />
                          <div>
                            <p className="font-serif text-[15px] text-[var(--color-botanical-primary)] font-medium">{item.name}</p>
                            <p className="text-[11px] text-[var(--color-botanical-subtle)]">Qty: {item.quantity || 1}</p>
                          </div>
                        </div>
                        <span className="text-[14px] font-bold text-[var(--color-botanical-primary)]">
                          ₹{(item.price * (item.quantity || 1)).toLocaleString('en-IN')}
                        </span>
                      </div>
                    ))}
                  </div>

                  <div className="border-t border-[var(--color-botanical-border)] pt-3 flex justify-between text-[14px]">
                    <span className="text-[var(--color-botanical-subtle)]">Payment: {ord.paymentStatus || ord.paymentMethod || 'Sample'}</span>
                    <span className="font-bold text-[var(--color-botanical-primary)]">Total: ₹{ord.total.toLocaleString('en-IN')}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {/* Activity (Notifications) Tab */}
        {activeTab === 'notifications' && (
          <div ref={contentRef} className="space-y-5">
            <div data-account-section className="flex items-center justify-between">
              <div>
                <h3 className="font-serif text-[22px] text-[var(--color-botanical-primary)]">Activity</h3>
                <p className="text-[12px] text-[var(--color-botanical-subtle)]">Order updates, custom request news and studio messages — saved to your account.</p>
              </div>
              {unreadNotifCount > 0 && (
                <button
                  type="button"
                  onClick={handleMarkAllRead}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full border border-[var(--color-botanical-border)] bg-[var(--color-surface-lowest)] text-[12px] font-semibold text-[var(--color-botanical-primary)] hover:bg-[var(--color-surface-low)] transition-all duration-300 hover:shadow-sm"
                >
                  <CheckCheck className="w-3.5 h-3.5" />
                  Mark all read
                </button>
              )}
            </div>

            {notifications.length === 0 ? (
              <div data-account-section className="relative bg-[var(--color-surface-lowest)] rounded-3xl p-10 border border-[var(--color-botanical-border)] text-center space-y-3 overflow-hidden">
                <div className="absolute -top-12 -right-12 w-36 h-36 rounded-full bg-[#ffdad3]/10 blur-3xl pointer-events-none" />
                <div className="relative w-14 h-14 rounded-full bg-[var(--color-surface-low)] mx-auto flex items-center justify-center">
                  <Bell className="w-6 h-6 text-[#964735]" />
                </div>
                <p className="relative font-serif text-[20px] text-[var(--color-botanical-primary)]">No activity yet</p>
                <p className="relative text-[13px] text-[var(--color-botanical-subtle)]">Order updates and studio messages will land here as they happen.</p>
                <div className="relative pt-1">
                  <Link to="/shop" className="inline-block px-6 py-2.5 rounded-full bg-[#180f0a] text-white text-[12px] font-semibold hover:bg-[#964735] transition-all duration-300">Browse Gifts</Link>
                </div>
              </div>
            ) : (
              <div className="space-y-3" aria-live="polite">
                {notifications.map((n) => (
                  <div key={n._id} data-account-section>
                    <button
                      type="button"
                      onClick={() => handleOpenNotification(n)}
                      className={`w-full text-left bg-[var(--color-surface-lowest)] rounded-2xl p-5 border transition-all duration-300 group ${!n.read ? 'border-[#c17c74]/40 shadow-sm hover:shadow-md' : 'border-[var(--color-botanical-border)] shadow-xs hover:shadow-sm'}`}
                    >
                      <div className="flex items-start gap-4">
                        <span className={`mt-1.5 w-2.5 h-2.5 rounded-full shrink-0 ${!n.read ? 'bg-[#964735]' : 'bg-[#d9d3cc]'}`} aria-label={n.read ? 'Read' : 'Unread'} title={n.read ? 'Read' : 'Unread'} />
                        <div className="min-w-0 flex-1">
                          <p className={`text-[14px] leading-snug ${!n.read ? 'font-semibold text-[var(--color-botanical-primary)]' : 'text-[var(--color-botanical-muted)]'}`}>{n.title}</p>
                          {n.message && <p className="text-[13px] text-[var(--color-botanical-subtle)] mt-0.5 leading-relaxed">{n.message}</p>}
                          <p className="text-[11px] text-[#b0a89f] mt-1.5">{new Date(n.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</p>
                        </div>
                        {n.link && <ArrowRight className="w-4 h-4 text-[#b0a89f] group-hover:text-[#964735] group-hover:translate-x-0.5 transition-all duration-300 shrink-0 mt-1" />}
                      </div>
                    </button>
                  </div>
                ))}
                {notifications.length > 0 && (
                  <div data-account-section className="text-center pt-2">
                    <Link to="/notifications" className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-[#964735] hover:underline">
                      Open full notification center <ArrowRight className="w-3.5 h-3.5" />
                    </Link>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Saved Gifts Tab */}
        {activeTab === 'saved' && (
          <div ref={contentRef} className="space-y-6">
            {wishlist.length === 0 ? (
              <div data-account-section className="relative bg-[var(--color-surface-lowest)] rounded-3xl p-10 border border-[var(--color-botanical-border)] text-center space-y-3 overflow-hidden">
                <div className="absolute -top-12 -right-12 w-36 h-36 rounded-full bg-[#ffdad3]/10 blur-3xl pointer-events-none" />
                <div className="relative w-16 h-16 rounded-full bg-[var(--color-surface-low)] mx-auto flex items-center justify-center text-3xl">🤍</div>
                <p className="relative font-serif text-[20px] text-[var(--color-botanical-primary)]">No saved gifts yet</p>
                <p className="relative text-[13px] text-[var(--color-botanical-subtle)]">Tap the heart on any bloom, card, or hamper to save it here.</p>
                <div className="relative pt-2">
                  <Link to="/shop" className="inline-block px-6 py-2.5 rounded-full bg-[#180f0a] text-white text-[12px] font-semibold hover:bg-[#964735] transition-all duration-300 hover:shadow-lg hover:-translate-y-0.5 active:translate-y-0">Browse the Collection</Link>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
                {wishlist.map((item) => (
                  <div key={item.id} data-account-section className="bg-[var(--color-surface-lowest)] rounded-2xl p-4 border border-[var(--color-botanical-border)] shadow-xs flex flex-col space-y-3 group hover:shadow-md transition-shadow duration-300">
                    <div className="relative aspect-square w-full rounded-xl overflow-hidden bg-[var(--color-surface-low)]">
                      <Link to={`/product/${item.id}`}>
                        <img
                          loading="lazy"
                          decoding="async" src={item.images ? item.images[0] : (item.image || '')} alt={item.name} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" />
                      </Link>
                      <button type="button" onClick={() => toggleWishlist(item)} className="absolute top-2 right-2 w-7 h-7 rounded-full bg-[var(--color-surface-lowest)]/90 shadow-sm flex items-center justify-center text-[#964735] hover:scale-110 transition-transform" title="Remove">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <div className="space-y-1 min-w-0">
                      <Link to={`/product/${item.id}`} className="font-serif text-[15px] text-[var(--color-botanical-primary)] font-medium hover:text-[#964735] transition-colors line-clamp-1">{item.name}</Link>
                      <p className="text-[14px] font-bold text-[var(--color-botanical-primary)]">₹{item.price.toLocaleString('en-IN')}</p>
                    </div>
                    <button type="button" onClick={() => addItemToCart(item)} className="w-full py-2 rounded-full bg-[#180f0a] text-white hover:bg-[#964735] text-[12px] font-semibold flex items-center justify-center gap-1.5 transition-all duration-300 hover:shadow-md hover:-translate-y-0.5 active:translate-y-0">
                      <ShoppingBag className="w-3.5 h-3.5" /> Move to Bag
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Profile Tab */}
        {activeTab === 'profile' && (
          <div ref={contentRef}>
            <div data-account-section className="relative bg-[var(--color-surface-lowest)] rounded-3xl p-6 sm:p-8 border border-[var(--color-botanical-border)] shadow-xs max-w-2xl space-y-6 overflow-hidden">
              <div className="absolute -top-16 -right-16 w-48 h-48 rounded-full bg-[#ffdad3]/8 blur-3xl pointer-events-none" />
              <div className="relative border-b border-[var(--color-botanical-border)] pb-3">
                <h3 className="font-serif text-[22px] text-[var(--color-botanical-primary)]">Profile</h3>
                <p className="text-[12px] text-[var(--color-botanical-subtle)]">
                  These details are saved to your account and used to prefill checkout.
                </p>
              </div>
              <form onSubmit={handleProfileSave} className="relative space-y-4" noValidate>
                <div>
                  <label className="block text-[11px] uppercase font-bold text-[var(--color-botanical-muted)] mb-1">Full Name</label>
                  <input
                    type="text"
                    value={profileForm.name}
                    onChange={(e) => setProfileForm({ ...profileForm, name: e.target.value })}
                    className="w-full px-4 py-2.5 rounded-xl bg-[var(--color-surface-low)] text-[14px] text-[var(--color-botanical-text)] border border-[var(--color-botanical-border)] focus:outline-none focus:ring-1 focus:ring-[#180f0a] transition-shadow duration-200"
                  />
                </div>
                <div>
                  <label className="block text-[11px] uppercase font-bold text-[var(--color-botanical-muted)] mb-1">Email Address</label>
                  <div className="relative">
                    <input
                      type="email"
                      value={displayEmail}
                      readOnly
                      className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-[var(--color-surface-container)] text-[14px] text-[var(--color-botanical-subtle)] border border-[var(--color-botanical-border)] cursor-not-allowed"
                    />
                    <Mail className="w-4 h-4 text-[var(--color-botanical-subtle)] absolute left-3.5 top-1/2 -translate-y-1/2" />
                  </div>
                  <p className="text-[11px] text-[var(--color-botanical-subtle)] mt-1">Email is your sign-in identity and cannot be changed here.</p>
                </div>
                <div>
                  <label className="block text-[11px] uppercase font-bold text-[var(--color-botanical-muted)] mb-1">Phone Number</label>
                  <div className="relative">
                    <input
                      type="tel"
                      value={profileForm.phone}
                      onChange={(e) => setProfileForm({ ...profileForm, phone: e.target.value })}
                      className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-[var(--color-surface-low)] text-[14px] text-[var(--color-botanical-text)] border border-[var(--color-botanical-border)] focus:outline-none focus:ring-1 focus:ring-[#180f0a] transition-shadow duration-200"
                    />
                    <Phone className="w-4 h-4 text-[var(--color-botanical-subtle)] absolute left-3.5 top-1/2 -translate-y-1/2" />
                  </div>
                </div>
                <button
                  type="submit"
                  disabled={profileSaving}
                  className="px-6 py-3 rounded-full bg-[#180f0a] hover:bg-[#964735] text-white text-[13px] font-semibold flex items-center gap-2 transition-all duration-300 disabled:opacity-50 hover:shadow-md hover:-translate-y-0.5 active:translate-y-0"
                >
                  <Check className="w-4 h-4" />
                  <span>{profileSaving ? 'Saving...' : 'Save Profile'}</span>
                </button>
              </form>
            </div>
          </div>
        )}

        {/* Addresses Tab */}
        {activeTab === 'addresses' && (
          <div ref={contentRef} className="space-y-6">
            <div data-account-section className="flex items-center justify-between">
              <div>
                <h3 className="font-serif text-[22px] text-[var(--color-botanical-primary)]">Saved Addresses</h3>
                <p className="text-[12px] text-[var(--color-botanical-subtle)]">
                  Your default address is used to prefill checkout. Saved to your account.
                </p>
              </div>
              <button
                type="button"
                onClick={startAddAddress}
                className="px-5 py-2.5 rounded-full bg-[#180f0a] hover:bg-[#964735] text-white text-[12px] font-semibold flex items-center gap-1.5 transition-all duration-300 hover:shadow-md hover:-translate-y-0.5 active:translate-y-0"
              >
                <Plus className="w-4 h-4" />
                <span>Add Address</span>
              </button>
            </div>

            {addresses.length === 0 && editingId !== 'new' ? (
              <div data-account-section className="relative bg-[var(--color-surface-lowest)] rounded-3xl p-10 border border-[var(--color-botanical-border)] text-center space-y-3 overflow-hidden">
                <div className="absolute -top-12 -right-12 w-36 h-36 rounded-full bg-[#d8e7cd]/10 blur-3xl pointer-events-none" />
                <p className="relative font-serif text-[20px] text-[var(--color-botanical-primary)]">No saved addresses yet</p>
                <p className="relative text-[13px] text-[var(--color-botanical-subtle)]">Add a delivery address so checkout can prefill it for you.</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {addresses.map((addr) => {
                  const id = addr._id || addr.id;
                  const isEditing = editingId === id;
                  return (
                    <div key={id} data-account-section className="bg-[var(--color-surface-lowest)] rounded-3xl p-6 border border-[var(--color-botanical-border)] shadow-xs space-y-3 hover:shadow-md transition-shadow duration-300">
                      {isEditing ? (
                        <AddressForm
                          form={addressForm}
                          setForm={setAddressForm}
                          onSave={handleAddressSave}
                          onCancel={cancelAddress}
                          saving={addressSaving}
                          error={addressError}
                        />
                      ) : (
                        <>
                          <div className="flex items-center justify-between border-b border-[var(--color-botanical-border)] pb-3">
                            <div className="flex items-center gap-2">
                              <span className="font-serif text-[16px] text-[var(--color-botanical-primary)]">{addr.label || 'Address'}</span>
                              {addr.isDefault && (
                                <span className="px-2 py-0.5 rounded-full bg-[#d8e7cd] text-[#081405] text-[10px] font-bold uppercase">
                                  Default
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => startEditAddress(addr)}
                                className="p-2 rounded-full text-[var(--color-botanical-subtle)] hover:text-[var(--color-botanical-primary)] hover:bg-[var(--color-surface-low)] transition-colors"
                                title="Edit address"
                              >
                                <Edit2 className="w-4 h-4" />
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDeleteAddress(addr)}
                                className="p-2 rounded-full text-[var(--color-botanical-subtle)] hover:text-red-600 hover:bg-[#ffdad6]/40 transition-colors"
                                title="Remove address"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          </div>
                          <div className="space-y-0.5 text-[14px] text-[var(--color-botanical-muted)]">
                            {addr.name && <p className="font-bold text-[var(--color-botanical-primary)]">{addr.name}</p>}
                            <p>{addr.address}</p>
                            <p>{addr.city}{addr.state ? `, ${addr.state}` : ''}{addr.pincode ? ` – ${addr.pincode}` : ''}</p>
                            {addr.phone && <p className="pt-1 text-[13px] text-[var(--color-botanical-subtle)]">Phone: {addr.phone}</p>}
                          </div>
                          {!addr.isDefault && (
                            <button
                              type="button"
                              onClick={() => handleSetDefault(addr)}
                              className="text-[12px] font-bold text-[#964735] hover:underline flex items-center gap-1"
                            >
                              <Star className="w-3.5 h-3.5" />
                              <span>Set as default</span>
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  );
                })}

                {editingId === 'new' && (
                  <div data-account-section className="bg-[var(--color-surface-lowest)] rounded-3xl p-6 border border-[var(--color-botanical-border)] shadow-xs hover:shadow-md transition-shadow duration-300">
                    <AddressForm
                      form={addressForm}
                      setForm={setAddressForm}
                      onSave={handleAddressSave}
                      onCancel={cancelAddress}
                      saving={addressSaving}
                      error={addressError}
                      isNew
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function AddressForm({ form, setForm, onSave, onCancel, saving, error, isNew }) {
  const set = (field) => (e) => setForm({ ...form, [field]: e.target.value });
  return (
    <form onSubmit={onSave} className="space-y-3" noValidate>
      {error && <p className="text-[12px] text-red-600 font-medium">{error}</p>}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-[10px] uppercase font-bold text-[var(--color-botanical-muted)] mb-1">Label</label>
          <input type="text" value={form.label} onChange={set('label')} className="w-full px-3 py-2 rounded-lg bg-[var(--color-surface-low)] text-[13px] border border-[var(--color-botanical-border)] focus:outline-none focus:ring-1 focus:ring-[#180f0a] transition-shadow duration-200" />
        </div>
        <div>
          <label className="block text-[10px] uppercase font-bold text-[var(--color-botanical-muted)] mb-1">Recipient Name</label>
          <input type="text" value={form.name} onChange={set('name')} className="w-full px-3 py-2 rounded-lg bg-[var(--color-surface-low)] text-[13px] border border-[var(--color-botanical-border)] focus:outline-none focus:ring-1 focus:ring-[#180f0a] transition-shadow duration-200" />
        </div>
      </div>
      <div>
        <label className="block text-[10px] uppercase font-bold text-[var(--color-botanical-muted)] mb-1">Street Address</label>
        <input type="text" value={form.address} onChange={set('address')} required className="w-full px-3 py-2 rounded-lg bg-[var(--color-surface-low)] text-[13px] border border-[var(--color-botanical-border)] focus:outline-none focus:ring-1 focus:ring-[#180f0a] transition-shadow duration-200" />
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="block text-[10px] uppercase font-bold text-[var(--color-botanical-muted)] mb-1">City</label>
          <input type="text" value={form.city} onChange={set('city')} required className="w-full px-3 py-2 rounded-lg bg-[var(--color-surface-low)] text-[13px] border border-[var(--color-botanical-border)] focus:outline-none focus:ring-1 focus:ring-[#180f0a] transition-shadow duration-200" />
        </div>
        <div>
          <label className="block text-[10px] uppercase font-bold text-[var(--color-botanical-muted)] mb-1">State</label>
          <input type="text" value={form.state} onChange={set('state')} required className="w-full px-3 py-2 rounded-lg bg-[var(--color-surface-low)] text-[13px] border border-[var(--color-botanical-border)] focus:outline-none focus:ring-1 focus:ring-[#180f0a] transition-shadow duration-200" />
        </div>
        <div>
          <label className="block text-[10px] uppercase font-bold text-[var(--color-botanical-muted)] mb-1">Pincode</label>
          <input type="text" value={form.pincode} onChange={set('pincode')} required className="w-full px-3 py-2 rounded-lg bg-[var(--color-surface-low)] text-[13px] border border-[var(--color-botanical-border)] focus:outline-none focus:ring-1 focus:ring-[#180f0a] transition-shadow duration-200" />
        </div>
      </div>
      <div>
        <label className="block text-[10px] uppercase font-bold text-[var(--color-botanical-muted)] mb-1">Phone</label>
        <input type="tel" value={form.phone} onChange={set('phone')} className="w-full px-3 py-2 rounded-lg bg-[var(--color-surface-low)] text-[13px] border border-[var(--color-botanical-border)] focus:outline-none focus:ring-1 focus:ring-[#180f0a] transition-shadow duration-200" />
      </div>
      <div className="flex items-center gap-3 pt-1">
        <button
          type="submit"
          disabled={saving}
          className="px-5 py-2.5 rounded-full bg-[#180f0a] hover:bg-[#964735] text-white text-[12px] font-semibold flex items-center gap-1.5 transition-all duration-300 disabled:opacity-50 hover:shadow-md"
        >
          <Check className="w-3.5 h-3.5" />
          <span>{saving ? 'Saving...' : isNew ? 'Save Address' : 'Save Changes'}</span>
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2.5 rounded-full border border-[var(--color-botanical-border)] text-[var(--color-botanical-subtle)] hover:text-[var(--color-botanical-primary)] text-[12px] font-semibold transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
