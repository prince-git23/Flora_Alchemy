import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { Bell, BellOff, Loader2, AlertCircle, ArrowRight, CheckCheck } from 'lucide-react';
import { Skeleton, SkeletonRow } from '../components/Skeleton.jsx';
import {
  fetchNotifications,
  markNotificationRead,
  markAllNotificationsRead,
} from '../services/notificationService.js';
import { getActiveCustomerId } from '../services/customerService.js';

/* ── GSAP ── */
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
gsap.registerPlugin(ScrollTrigger);

const prefersReduced = typeof window !== 'undefined' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * NotificationsPage — the customer's premium activity center.
 *
 * Route: /notifications (customer-facing).
 * Data: GET /api/notifications (backend-owned per-user feed).
 * Mark-read: PATCH /api/notifications/:id/read and /read-all.
 * There is NO localStorage persistence — the backend is authoritative.
 */

const TYPE_META = {
  order_status_change: { icon: '📦', label: 'Order update' },
  payment_received: { icon: '💠', label: 'Payment' },
  payment_failed: { icon: '⚠️', label: 'Payment issue' },
  custom_request_status: { icon: '✉️', label: 'Custom request' },
  new_message: { icon: '💬', label: 'Message' },
  new_order: { icon: '📦', label: 'Order' },
  system: { icon: '🔔', label: 'Flora Alchemy' },
};

function relativeTime(dateStr) {
  if (!dateStr) return '';
  const then = new Date(dateStr).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hr${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(dateStr).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

function NotificationCard({ notification, onOpen }) {
  const meta = TYPE_META[notification.type] || TYPE_META.system;
  const unread = !notification.read;
  const destination = notification.link || null;

  return (
    <button
      type="button"
      onClick={() => onOpen(notification)}
      className={`w-full text-left bg-[var(--color-surface-lowest)] rounded-2xl p-5 border transition-all duration-300 group ${
        unread
          ? 'border-[#c17c74]/40 shadow-md hover:shadow-lg hover:-translate-y-0.5'
          : 'border-[var(--color-botanical-border)] shadow-xs hover:shadow-sm'
      }`}
      aria-label={unread ? `${meta.label}: ${notification.title} (unread)` : `${meta.label}: ${notification.title}`}
    >
      <div className="flex items-start gap-4">
        <div className={`w-11 h-11 rounded-2xl flex items-center justify-center text-[18px] shrink-0 ${unread ? 'bg-[#ffdad3]/60' : 'bg-[var(--color-surface-low)]'}`} aria-hidden="true">
          {meta.icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] font-bold uppercase tracking-widest text-[#964735]">{meta.label}</span>
            {!unread && <span className="text-[10px] uppercase tracking-wider text-[#b0a89f]">· Read</span>}
          </div>
          <p className={`mt-1 text-[14px] leading-snug ${unread ? 'font-semibold text-[var(--color-botanical-primary)]' : 'text-[var(--color-botanical-muted)]'}`}>
            {notification.title}
          </p>
          {notification.message && (
            <p className="mt-0.5 text-[13px] text-[var(--color-botanical-subtle)] leading-relaxed">{notification.message}</p>
          )}
          <p className="mt-2 text-[11px] text-[#b0a89f]">
            <time dateTime={notification.createdAt}>{relativeTime(notification.createdAt)}</time>
          </p>
        </div>
        <div className="shrink-0 flex flex-col items-end gap-2">
          {unread && (
            <span className="w-2.5 h-2.5 rounded-full bg-[#964735]" aria-label="Unread" title="Unread" />
          )}
          {destination && (
            <ArrowRight className="w-4 h-4 text-[#b0a89f] group-hover:text-[#964735] group-hover:translate-x-0.5 transition-all duration-300" aria-hidden="true" />
          )}
        </div>
      </div>
    </button>
  );
}

export default function NotificationsPage() {
  const navigate = useNavigate();
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('all'); // 'all' | 'unread'
  const [markingAll, setMarkingAll] = useState(false);
  const authed = !!getActiveCustomerId();
  const pageRef = useRef(null);
  const listRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await fetchNotifications();
      setNotifications(data.notifications || []);
      setUnreadCount(data.unreadCount ?? 0);
    } catch (err) {
      setError(err.message || 'Failed to load notifications.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authed) load();
  }, [authed, load]);

  /* ── GSAP: header + staggered stream ── */
  useEffect(() => {
    if (prefersReduced || loading || !pageRef.current) return;
    const ctx = gsap.context(() => {
      gsap.from('[data-notif-hero]', { y: 26, opacity: 0, duration: 0.7, ease: 'power3.out' });
      const cards = listRef.current?.querySelectorAll('[data-notif-card]');
      if (cards && cards.length) {
        gsap.from(cards, {
          y: 20, opacity: 0, duration: 0.55, ease: 'power3.out', stagger: 0.07,
          scrollTrigger: { trigger: listRef.current, start: 'top 90%', once: true },
        });
      }
    }, pageRef);
    return () => ctx.revert();
  }, [loading, filter, notifications.length]);

  // Guests are redirected to sign in — the feed is private.
  if (!authed) {
    return <Navigate to={`/login?redirect=${encodeURIComponent('/notifications')}`} replace />;
  }

  const handleOpen = async (n) => {
    // Mark read first (fire-and-forget), then navigate to the real destination.
    if (!n.read) {
      setNotifications((prev) => prev.map((x) => (x._id === n._id ? { ...x, read: true } : x)));
      setUnreadCount((c) => Math.max(0, c - 1));
      try {
        const res = await markNotificationRead(n._id);
        if (res && typeof res.unreadCount === 'number') setUnreadCount(res.unreadCount);
      } catch {
        setNotifications((prev) => prev.map((x) => (x._id === n._id ? { ...x, read: false } : x)));
        setUnreadCount((c) => c + 1);
      }
    }
    if (n.link) navigate(n.link);
  };

  const handleMarkAllRead = async () => {
    setMarkingAll(true);
    try {
      await markAllNotificationsRead();
      setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
      setUnreadCount(0);
    } catch (err) {
      setError(err.message || 'Could not mark notifications as read.');
    } finally {
      setMarkingAll(false);
    }
  };

  const visible = filter === 'unread' ? notifications.filter((n) => !n.read) : notifications;

  return (
    <div ref={pageRef} className="w-full bg-[var(--color-surface-bg)] min-h-screen py-6 lg:py-16 relative overflow-hidden">
      {/* Ambient glow orbs */}
      <div className="absolute top-0 right-0 w-96 h-96 rounded-full bg-[#ffdad3]/12 blur-3xl pointer-events-none" />
      <div className="absolute bottom-40 left-0 w-80 h-80 rounded-full bg-[#d8e7cd]/10 blur-3xl pointer-events-none" />

      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 relative">
        {/* Header */}
        <div data-notif-hero className="relative text-center max-w-xl mx-auto mb-6 sm:mb-8 space-y-2 sm:space-y-3">
          <div className="relative w-16 h-16 rounded-full bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] shadow-sm flex items-center justify-center mx-auto">
            <Bell className="w-7 h-7 text-[#964735]" />
            {unreadCount > 0 && (
              <span className="absolute -top-1 -right-1 min-w-[22px] h-[22px] px-1.5 rounded-full bg-[#964735] text-white text-[11px] font-bold flex items-center justify-center shadow-md">
                {unreadCount > 99 ? '99+' : unreadCount}
              </span>
            )}
          </div>
          <span className="block text-[11px] uppercase font-bold tracking-widest text-[#964735]">Your Activity</span>
          <h1 className="font-serif text-[28px] sm:text-[34px] lg:text-[42px] text-[var(--color-botanical-primary)] tracking-tight leading-tight">
            Notifications
          </h1>
          <p className="text-[14px] text-[var(--color-botanical-muted)]">
            {unreadCount > 0
              ? `You have ${unreadCount} unread update${unreadCount === 1 ? '' : 's'} from the studio.`
              : 'Order updates, custom requests and studio messages will appear here.'}
          </p>
        </div>

        {/* Toolbar */}
        <div className="relative flex items-center justify-between gap-2 sm:gap-3 mb-4 sm:mb-5">
          <div className="inline-flex rounded-full bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] p-1 shadow-xs" role="tablist" aria-label="Filter notifications">
            {[
              { key: 'all', label: `All (${notifications.length})` },
              { key: 'unread', label: `Unread (${unreadCount})` },
            ].map((f) => (
              <button
                key={f.key}
                type="button"
                role="tab"
                aria-selected={filter === f.key}
                onClick={() => setFilter(f.key)}
                className={`px-4 py-1.5 rounded-full text-[12px] font-semibold transition-all duration-300 ${
                  filter === f.key
                    ? 'bg-[#180f0a] text-white shadow-sm'
                    : 'text-[var(--color-botanical-muted)] hover:text-[var(--color-botanical-primary)] hover:bg-[var(--color-surface-low)]'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
          {unreadCount > 0 && (
            <button
              type="button"
              onClick={handleMarkAllRead}
              disabled={markingAll}
              className="inline-flex items-center gap-1.5 px-3 sm:px-4 py-2 rounded-full border border-[var(--color-botanical-border)] bg-[var(--color-surface-lowest)] text-[11px] sm:text-[12px] font-semibold text-[var(--color-botanical-primary)] hover:bg-[var(--color-surface-low)] transition-all duration-300 disabled:opacity-50 touch-target"
            >
              {markingAll ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCheck className="w-3.5 h-3.5" />}
              Mark all read
            </button>
          )}
        </div>

        {/* Stream */}
        {loading ? (
          <div className="bg-[var(--color-surface-lowest)] rounded-3xl border border-[var(--color-botanical-border)] p-6 shadow-sm space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <SkeletonRow key={i} className="rounded-xl" />
            ))}
          </div>
        ) : error ? (
          <div className="bg-[var(--color-surface-lowest)] rounded-3xl border border-[var(--color-botanical-border)] p-12 text-center shadow-sm space-y-4">
            <AlertCircle className="w-10 h-10 text-[#c17c74] mx-auto" />
            <p className="font-serif text-[20px] text-[var(--color-botanical-primary)]">Something went wrong</p>
            <p className="text-[13px] text-[var(--color-botanical-subtle)]">{error}</p>
            <button
              type="button"
              onClick={load}
              className="inline-flex px-6 py-2.5 rounded-full bg-[#180f0a] text-white text-[12px] font-semibold hover:bg-[#964735] transition-colors"
            >
              Try Again
            </button>
          </div>
        ) : visible.length === 0 ? (
          <div className="relative bg-[var(--color-surface-lowest)] rounded-3xl p-12 text-center border border-[var(--color-botanical-border)] shadow-sm space-y-3 overflow-hidden">
            <div className="absolute -top-12 -right-12 w-36 h-36 rounded-full bg-[#ffdad3]/10 blur-3xl pointer-events-none" />
            <div className="relative w-14 h-14 rounded-full bg-[var(--color-surface-low)] flex items-center justify-center mx-auto">
              <BellOff className="w-6 h-6 text-[#964735]" />
            </div>
            <p className="relative font-serif text-[22px] text-[var(--color-botanical-primary)]">
              {filter === 'unread' ? 'All caught up' : 'Nothing here yet'}
            </p>
            <p className="relative text-[13px] text-[var(--color-botanical-subtle)] max-w-sm mx-auto">
              {filter === 'unread'
                ? 'Every update has been read. New order and request news will land here.'
                : 'Place an order or start a custom request and the studio will keep you posted.'}
            </p>
            {filter === 'all' && (
              <div className="relative pt-2 flex flex-wrap justify-center gap-3">
                <Link to="/shop" className="px-6 py-2.5 rounded-full bg-[#180f0a] text-white text-[12px] font-semibold hover:bg-[#964735] transition-colors">Browse Gifts</Link>
                <Link to="/account" className="px-6 py-2.5 rounded-full border border-[var(--color-botanical-border)] bg-[var(--color-surface-lowest)] text-[var(--color-botanical-primary)] text-[12px] font-semibold hover:bg-[var(--color-surface-low)] transition-colors">My Account</Link>
              </div>
            )}
          </div>
        ) : (
          <div ref={listRef} className="relative space-y-3" aria-live="polite">
            {visible.map((n) => (
              <div key={n._id} data-notif-card>
                <NotificationCard notification={n} onOpen={handleOpen} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
