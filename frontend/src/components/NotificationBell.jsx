import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Bell, Loader2 } from 'lucide-react';
import {
  fetchNotifications,
  fetchUnreadCount,
  markNotificationRead,
} from '../services/notificationService.js';
import { getActiveCustomerId } from '../services/customerService.js';

/**
 * NotificationBell — customer navbar bell.
 *
 * Shows the backend unread count (GET /api/notifications/unread-count) and a
 * dropdown of the most recent notifications for the signed-in customer.
 * Only rendered for authenticated customers; the count is never faked.
 */
export default function NotificationBell() {
  const authed = !!getActiveCustomerId();
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const dropdownRef = useRef(null);
  const pollRef = useRef(null);

  // Lightweight unread-count polling (30s) — only while signed in.
  useEffect(() => {
    if (!authed) return undefined;
    let cancelled = false;
    const poll = async () => {
      try {
        const count = await fetchUnreadCount();
        if (!cancelled) setUnreadCount(count);
      } catch {
        // Silent — non-critical indicator
      }
    };
    poll();
    pollRef.current = setInterval(poll, 30000);
    return () => {
      cancelled = true;
      clearInterval(pollRef.current);
    };
  }, [authed]);

  // Load recent notifications when the dropdown opens.
  useEffect(() => {
    if (!open || !authed) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const data = await fetchNotifications();
        if (!cancelled) {
          setNotifications(data.notifications || []);
          setUnreadCount(data.unreadCount ?? 0);
        }
      } catch {
        if (!cancelled) setNotifications([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, authed]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return undefined;
    const onDocClick = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const handleMarkRead = useCallback(async (id) => {
    setNotifications((prev) => prev.map((n) => (n._id === id ? { ...n, read: true } : n)));
    setUnreadCount((c) => Math.max(0, c - 1));
    try {
      const res = await markNotificationRead(id);
      if (res && typeof res.unreadCount === 'number') setUnreadCount(res.unreadCount);
    } catch {
      // Optimistic update; count refreshes within 30s regardless.
    }
  }, []);

  if (!authed) return null;

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="relative p-2 rounded-full hover:bg-[var(--color-surface-container)] transition-all duration-200 flex items-center justify-center min-w-[36px] min-h-[36px]"
        title="Notifications"
        aria-label={`Notifications${unreadCount > 0 ? `, ${unreadCount} unread` : ''}`}
        aria-expanded={open}
      >
        <Bell className="w-5 h-5 text-[var(--color-botanical-muted)]" aria-hidden="true" />
        {unreadCount > 0 && (
          <span className="absolute top-0.5 right-0.5 min-w-[16px] h-4 px-1 bg-[#964735] text-white rounded-full text-[9px] font-bold flex items-center justify-center leading-none">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          className="fixed inset-x-3 top-16 sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-2 w-auto sm:w-80 md:w-96 max-w-[calc(100vw-1.5rem)] bg-[var(--color-surface-lowest)] rounded-2xl shadow-2xl border border-[var(--color-botanical-border)] overflow-hidden z-50 animate-fade-in"
          role="dialog"
          aria-label="Recent notifications"
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-botanical-border)]">
            <span className="text-[13px] font-bold text-[var(--color-botanical-primary)]">Notifications</span>
            <Link to="/notifications" onClick={() => setOpen(false)} className="text-[11px] font-semibold text-[#964735] hover:underline">
              View all
            </Link>
          </div>
          <div className="max-h-[60vh] sm:max-h-80 overflow-y-auto">
            {loading ? (
              <div className="p-8 text-center"><Loader2 className="w-5 h-5 text-[#964735] animate-spin mx-auto" /></div>
            ) : notifications.length === 0 ? (
              <div className="p-8 text-center text-[12px] text-[var(--color-botanical-subtle)]">
                <p className="font-serif text-[15px] text-[var(--color-botanical-primary)] mb-1">No notifications yet</p>
                <p className="text-[11px]">Order updates and studio messages will appear here.</p>
              </div>
            ) : (
              notifications.slice(0, 6).map((n) => (
                <Link
                  key={n._id}
                  to={n.link || '/notifications'}
                  onClick={() => { if (!n.read) handleMarkRead(n._id); setOpen(false); }}
                  className={`block w-full text-left px-4 py-3 border-b border-[var(--color-botanical-border-light)] last:border-b-0 hover:bg-[var(--color-surface-low)] transition-colors ${!n.read ? 'bg-[var(--color-surface-container)]' : ''}`}
                >
                  <div className="flex items-start gap-3">
                    <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${!n.read ? 'bg-[#964735]' : 'bg-transparent'}`} aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <p className={`text-[12px] leading-snug ${!n.read ? 'font-semibold text-[var(--color-botanical-primary)]' : 'text-[var(--color-botanical-muted)]'}`}>{n.title}</p>
                      <p className="text-[11px] text-[var(--color-botanical-subtle)] mt-0.5 line-clamp-2">{n.message}</p>
                    </div>
                  </div>
                </Link>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
