import React, { useState, useEffect, useMemo } from 'react';
import { useStoreVersion } from '../../hooks/useStoreVersion.js';
import { Link, useNavigate } from 'react-router-dom';
import AdminLayout from '../../components/admin/AdminLayout.jsx';
import { listConversations } from '../../services/conversationService.js';
import { getOrders, formatDate, formatINR } from '../../services/orderService.js';
import { getCustomers } from '../../services/customerService.js';
import { AdminConversationStatusPill } from '../../components/admin/AdminStatusPill.jsx';

export default function AdminConversationsPage() {
  const storeVersion = useStoreVersion();
  const navigate = useNavigate();
  const [conversations, setConversations] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [statusFilter, setStatusFilter] = useState('all');
  // Phase 20.1 — Retry re-runs the local fetch instead of reloading the whole
  // application (window.location.reload previously remounted the entire admin
  // portal just to retry one request).
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    async function load() {
      setLoaded(false);
      setLoadError(null);
      try {
        const list = await listConversations({ limit: 100, scope: 'admin' });
        if (active) setConversations(Array.isArray(list) ? list : []);
      } catch (err) {
        if (active) setLoadError(err.message || 'Unable to load conversations.');
      } finally {
        if (active) setLoaded(true);
      }
    }
    load();
    return () => {
      active = false;
    };
  }, [reloadKey]);

  const orders = useMemo(() => getOrders(), [storeVersion]);
  const customers = useMemo(() => {
    const map = {};
    getCustomers().forEach((c) => {
      const key = String(c.id || c._id || '');
      if (key) map[key] = c;
    });
    return map;
  }, [conversations]);

  const enriched = useMemo(() => {
    return conversations.map((conv) => {
      const order = orders.find(
        (o) => String(o.id || o._id) === String(conv.orderId)
      );
      const customer = order
        ? customers[String(order.customerId)] || null
        : null;
      return {
        ...conv,
        orderId: conv.orderId,
        customerName: customer?.name || order?.customerName || 'Customer',
        orderTotal: order?.total || 0,
        orderStatus: order?.orderStatus || 'new',
        lastMessage: conv.lastMessage || null,
        unreadCount: conv.unreadCount || 0,
      };
    });
  }, [conversations, orders, customers]);

  const filtered = useMemo(() => {
    if (statusFilter === 'all') return enriched;
    return enriched.filter((c) => c.status === statusFilter);
  }, [enriched, statusFilter]);

  return (
    <AdminLayout>
      <div className="max-w-7xl mx-auto space-y-6 pb-12">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="font-serif text-3xl sm:text-4xl text-[var(--color-botanical-primary)] tracking-tight font-normal">
              Conversations
            </h1>
            <p className="text-[14px] text-[var(--color-botanical-muted)] mt-1">
              Order-linked customer messages
              {loaded && !loadError
                ? ` · ${conversations.length} conversation${conversations.length !== 1 ? 's' : ''}`
                : ''}
            </p>
          </div>
        </div>

        {/* Status Filters */}
        <div className="flex items-center gap-2" role="group" aria-label="Filter by status">
          {['all', 'open', 'closed'].map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatusFilter(s)}
              aria-pressed={statusFilter === s}
              className={`px-4 py-1.5 rounded-full text-[12px] font-semibold transition-all ${
                statusFilter === s
                  ? 'bg-[var(--color-btn)] text-white shadow-sm'
                  : 'bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] text-[var(--color-botanical-muted)] hover:bg-[var(--color-surface-low)]'
              }`}
            >
              {s === 'all' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>

        {/* Loading State */}
        {!loaded && (
          <div className="space-y-3">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="flex items-center gap-4 p-4 bg-[var(--color-surface-lowest)] dark:bg-[#1e1b18] rounded-xl border border-[var(--color-botanical-border)] dark:border-[#3a3530] animate-pulse">
                <div className="w-10 h-10 rounded-full bg-[var(--color-surface-container)] dark:bg-[#2a2520]" />
                <div className="flex-1 space-y-2">
                  <div className="h-3 w-1/3 bg-[var(--color-surface-container)] dark:bg-[#2a2520] rounded" />
                  <div className="h-2.5 w-2/3 bg-[var(--color-surface-container)] dark:bg-[#2a2520] rounded" />
                </div>
                <div className="h-6 w-16 bg-[var(--color-surface-container)] dark:bg-[#2a2520] rounded-full" />
              </div>
            ))}
          </div>
        )}

        {/* Error State */}
        {loadError && (
          <div className="bg-[var(--color-surface-lowest)] rounded-2xl border border-[var(--color-botanical-border)] p-8 text-center">
            <p className="text-[14px] text-[var(--color-accent)] font-medium">{loadError}</p>
            <button
              type="button"
              onClick={() => setReloadKey((k) => k + 1)}
              className="mt-3 px-4 py-2 rounded-full bg-[var(--color-btn)] text-white text-[12px] font-semibold hover:bg-[var(--color-btn-hover)] transition-colors"
            >
              Retry
            </button>
          </div>
        )}

        {/* Empty State */}
        {loaded && !loadError && filtered.length === 0 && (
          <div className="bg-[var(--color-surface-lowest)] rounded-2xl border border-[var(--color-botanical-border)] p-12 text-center space-y-3">
            <div className="w-14 h-14 rounded-full bg-[var(--color-surface-low)] mx-auto flex items-center justify-center">
              <span className="material-symbols-outlined text-[28px] text-[var(--color-botanical-subtle)]">
                chat_bubble_outline
              </span>
            </div>
            <p className="font-serif text-[20px] text-[var(--color-botanical-primary)]">
              {statusFilter === 'all' ? 'No conversations yet' : `No ${statusFilter} conversations`}
            </p>
            <p className="text-[13px] text-[var(--color-botanical-subtle)] max-w-md mx-auto">
              Customer conversations appear here when they message about an order.
            </p>
          </div>
        )}

        {/* Conversation List */}
        {loaded && !loadError && filtered.length > 0 && (
          <div className="bg-[var(--color-surface-lowest)] rounded-2xl border border-[var(--color-botanical-border)] shadow-xs overflow-hidden">
            <div className="divide-y divide-[var(--color-divider)]">
              {filtered.map((conv) => (
                <button
                  key={conv._id || conv.id || conv.orderId}
                  type="button"
                  onClick={() =>
                    navigate(`/admin/orders/${conv.orderId}/conversation`)
                  }
                  className={`w-full text-left px-5 py-4 transition-colors flex items-center gap-4 ${
                    conv.unreadCount > 0 ? 'bg-[#fdf6f4] hover:bg-[#f9ebe8]' : 'hover:bg-[var(--color-surface-low)]'
                  }`}
                >
                  {/* Customer initial */}
                  <div className="w-10 h-10 rounded-full bg-[var(--color-btn)] text-white flex items-center justify-center text-[14px] font-bold shrink-0">
                    {(conv.customerName || 'C').charAt(0).toUpperCase()}
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-[14px] font-semibold text-[var(--color-botanical-primary)] truncate">
                        {conv.customerName}
                      </span>
                      <span className="text-[12px] text-[var(--color-botanical-subtle)]">
                        · Order #{conv.orderId}
                      </span>
                      {conv.orderTotal > 0 && (
                        <span className="text-[12px] text-[var(--color-botanical-subtle)]">
                          · {formatINR(conv.orderTotal)}
                        </span>
                      )}
                    </div>
                    {conv.lastMessage && (
                      <p className="text-[13px] text-[var(--color-botanical-muted)] truncate">
                        {conv.lastMessage.body || conv.lastMessage}
                      </p>
                    )}
                    {!conv.lastMessage && (
                      <p className="text-[12px] text-[#b0a89f] italic">
                        No messages yet
                      </p>
                    )}
                  </div>

                  {/* Status + unread */}
                  <div className="flex items-center gap-3 shrink-0">
                    <AdminConversationStatusPill status={conv.status || 'open'} />
                    {conv.unreadCount > 0 && (
                      <span className="min-w-[20px] h-5 px-1.5 rounded-full bg-[#964735] text-white text-[10px] font-bold flex items-center justify-center" aria-label={`${conv.unreadCount} unread messages`}>
                        {conv.unreadCount}
                      </span>
                    )}
                    <span className="material-symbols-outlined text-[18px] text-[#d1c4bd]">
                      chevron_right
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
