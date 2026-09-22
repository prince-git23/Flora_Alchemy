import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Bell } from 'lucide-react';
import {
  fetchNotifications,
  fetchUnreadCount,
  markNotificationRead,
  markAllNotificationsRead,
} from '../../services/notificationService.js';

/**
 * NotificationBell — shows unread count badge and a dropdown of recent
 * notifications. Polls for unread count every 30 seconds. Created by the
 * notification system in Phase 14 integration work.
 */
export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const dropdownRef = useRef(null);
  const pollRef = useRef(null);

  // Poll for unread count
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        // Phase 20.1 — admin session scope: the backend feed is per-user
        // (staff or customer); sending no token polled a guaranteed 401.
        const count = await fetchUnreadCount('admin');
        if (!cancelled) setUnreadCount(count);
      } catch {
        // Silently fail — non-critical
      }
    };
    poll();
    pollRef.current = setInterval(poll, 30000);
    return () => {
      cancelled = true;
      clearInterval(pollRef.current);
    };
  }, []);

  // Load notifications when dropdown opens
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError('');
      try {
        const data = await fetchNotifications(false, 'admin');
        if (!cancelled) {
          setNotifications(data.notifications || []);
          setUnreadCount(data.unreadCount ?? 0);
        }
      } catch (err) {
        if (!cancelled) setError('Failed to load notifications.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleMarkRead = useCallback(async (id) => {
    try {
      const data = await markNotificationRead(id, 'admin');
      setNotifications((prev) => prev.map((n) => n._id === id ? { ...n, read: true } : n));
      setUnreadCount(data.unreadCount ?? 0);
    } catch {
      // Non-critical
    }
  }, []);

  const handleMarkAllRead = useCallback(async () => {
    try {
      await markAllNotificationsRead('admin');
      setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
      setUnreadCount(0);
    } catch {
      // Non-critical
    }
  }, []);

  const typeIcon = (type) => {
    switch (type) {
      case 'new_order': return '📦';
      case 'order_status_change': return '📋';
      case 'payment_received': return '💰';
      case 'payment_failed': return '⚠️';
      case 'low_stock': return '📉';
      case 'critical_stock': return '🚨';
      case 'new_customer': return '👤';
      case 'new_custom_request': return '✉️';
      case 'new_message': return '💬';
      default: return '🔔';
    }
  };

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="relative p-2 rounded-lg hover:bg-[#f0ede8] transition-colors"
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ''}`}
        aria-expanded={open}
        aria-haspopup="true"
      >
        <Bell className="w-5 h-5 text-[var(--color-botanical-muted)]" />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] rounded-full bg-[#964735] text-white text-[10px] font-bold flex items-center justify-center px-1">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="fixed inset-x-3 top-16 sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-2 w-auto sm:w-80 md:w-96 max-w-[calc(100vw-1.5rem)] bg-[var(--color-surface-lowest)] rounded-2xl shadow-2xl border border-[var(--color-botanical-border)] overflow-hidden z-50 animate-fade-in">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-botanical-border)]">
            <span className="text-[13px] font-bold text-[var(--color-botanical-primary)]">Notifications</span>
            {unreadCount > 0 && (
              <button
                onClick={handleMarkAllRead}
                className="text-[11px] font-semibold text-[var(--color-accent)] hover:underline"
              >
                Mark all read
              </button>
            )}
          </div>

          {/* Body */}
          <div className="max-h-80 overflow-y-auto">
            {loading ? (
              <div className="p-8 text-center text-[12px] text-[var(--color-botanical-subtle)]">Loading…</div>
            ) : error ? (
              <div className="p-8 text-center text-[12px] text-red-600">{error}</div>
            ) : notifications.length === 0 ? (
              <div className="p-8 text-center text-[12px] text-[var(--color-botanical-subtle)]">
                <p>No notifications yet.</p>
                <p className="mt-1 text-[11px]">You'll see order updates, low-stock alerts, and messages here.</p>
              </div>
            ) : (
              notifications.map((n) => (
                <button
                  key={n._id}
                  onClick={() => {
                    handleMarkRead(n._id);
                    if (n.link) {
                      setOpen(false);
                      // Navigate is handled by the Link below
                    }
                  }}
                  className={`w-full text-left px-4 py-3 border-b border-[#f0ede8] hover:bg-[var(--color-surface-low)] transition-colors ${
                    !n.read ? 'bg-[#f9f7f3]' : ''
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <span className="text-[16px] shrink-0 mt-0.5" aria-hidden="true">
                      {typeIcon(n.type)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className={`text-[12px] leading-snug ${!n.read ? 'font-semibold text-[var(--color-botanical-primary)]' : 'text-[var(--color-botanical-muted)]'}`}>
                        {n.title}
                      </p>
                      <p className="text-[11px] text-[var(--color-botanical-subtle)] mt-0.5 line-clamp-2">{n.message}</p>
                      <p className="text-[10px] text-[#b0a99f] mt-1">
                        {new Date(n.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}
                      </p>
                    </div>
                    {!n.read && (
                      <span className="w-2 h-2 rounded-full bg-[#964735] shrink-0 mt-1.5" aria-label="Unread" />
                    )}
                  </div>
                  {n.link && (
                    <Link
                      to={n.link}
                      onClick={() => setOpen(false)}
                      className="block mt-1 text-[11px] font-semibold text-[var(--color-accent)] hover:underline"
                    >
                      View details →
                    </Link>
                  )}
                </button>
              ))
            )}
          </div>

          {/* Footer */}
          {notifications.length > 0 && (
            <div className="px-4 py-2 border-t border-[var(--color-botanical-border)] text-center">
              <span className="text-[11px] text-[var(--color-botanical-subtle)]">
                Showing {notifications.length} most recent
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
