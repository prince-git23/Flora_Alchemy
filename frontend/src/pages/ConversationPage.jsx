import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { Send, ArrowLeft, MessageSquare, Loader2, AlertCircle } from 'lucide-react';
import { getOrCreateConversation, getMessages, sendMessage, markAsRead } from '../services/conversationService.js';
import { getOrderById, fetchOrderFromApi, formatINR, getStatusLabel, getStatusStage } from '../services/orderService.js';
import { getToken } from '../services/apiClient.js';
import api from '../services/apiClient.js';

/* ── GSAP (customer view only) ── */
import gsap from 'gsap';

const prefersReduced = typeof window !== 'undefined' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * ConversationPage — order-linked customer ↔ handler text chat.
 *
 * Route: /order/:orderId/conversation (customer)
 *        /admin/orders/:orderId/conversation (admin)
 *
 * Determines view mode from the URL path.
 */

function isAdminView(pathname) {
  return pathname.startsWith('/admin');
}

function MessageBubble({ message, isOwn }) {
  const time = message.createdAt
    ? new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';

  return (
    <div className={`flex ${isOwn ? 'justify-end' : 'justify-start'} mb-3`}>
      <div className={`max-w-[75%] ${isOwn ? 'order-2' : ''}`}>
        <div
          className={`px-4 py-2.5 rounded-2xl text-[14px] leading-relaxed ${
            isOwn
              ? 'bg-[#964735] text-white rounded-br-md'
              : 'bg-white border border-[#e5e2dd] text-[#180f0a] rounded-bl-md'
          }`}
        >
          {message.body}
        </div>
        <div className={`flex items-center gap-1.5 mt-1 ${isOwn ? 'justify-end' : ''}`}>
          <span className="text-[11px] text-[#80756f]">{message.senderName || (isOwn ? 'You' : 'Flora Alchemy')}</span>
          <span className="text-[11px] text-[#b0a89f]">·</span>
          <span className="text-[11px] text-[#b0a89f]">{time}</span>
        </div>
      </div>
    </div>
  );
}

function EmptyState({ onStartConversation }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center p-12 text-center">
      <div className="w-16 h-16 rounded-full bg-[#f6f3ee] flex items-center justify-center mb-5">
        <MessageSquare className="w-7 h-7 text-[#964735]" />
      </div>
      <h3 className="font-serif text-[20px] text-[#180f0a] font-medium mb-2">Need help with your order?</h3>
      <p className="text-[14px] text-[#80756f] max-w-sm mb-6 leading-relaxed">
        Send a message to the Flora Alchemy team about your commission. We typically respond within a few hours.
      </p>
      <button
        onClick={onStartConversation}
        className="inline-flex items-center gap-2 px-6 py-3 rounded-full bg-[#964735] text-white text-[13px] font-semibold shadow-md hover:bg-[#7d3a2b] transition-colors"
      >
        <MessageSquare className="w-4 h-4" />
        Message Flora Alchemy
      </button>
    </div>
  );
}

export default function ConversationPage() {
  const { orderId, conversationId: paramConvId } = useParams();
  const navigate = useNavigate();
  const pathname = window.location.pathname;
  const admin = isAdminView(pathname);

  const [conversation, setConversation] = useState(null);
  const [order, setOrder] = useState(null);
  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [initialized, setInitialized] = useState(false);
  const messagesEndRef = useRef(null);
  const textareaRef = useRef(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  // Determine the effective orderId from route params
  const effectiveOrderId = orderId || (admin && paramConvId ? null : paramConvId);

  // Initialize: load order + conversation
  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        setLoading(true);
        setError(null);

        // Load the order from the API to get the current database-backed status.
        let orderData = getOrderById(effectiveOrderId);
        if (!orderData) {
          orderData = await fetchOrderFromApi(effectiveOrderId);
        }
        if (!orderData) {
          if (!cancelled) setError('Order not found.');
          return;
        }
        if (!cancelled) setOrder(orderData);

        // Get or create conversation
        const convScope = admin ? 'admin' : 'customer';
        const conv = await getOrCreateConversation(effectiveOrderId, { scope: convScope });
        if (cancelled) return;
        setConversation(conv);

        // Load messages
        const msgs = await getMessages(conv.id || conv._id, { scope: convScope });
        if (cancelled) return;
        setMessages(msgs);

        // Mark as read
        await markAsRead(conv.id || conv._id, { scope: convScope });

        setInitialized(true);
      } catch (err) {
        if (!cancelled) setError(err.message || 'Failed to load conversation.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    if (effectiveOrderId) init();
    return () => { cancelled = true; };
  }, [effectiveOrderId]);

  // Scroll to bottom when messages change
  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // Poll for new messages every 10 seconds (simple HTTP polling, no WebSocket)
  useEffect(() => {
    if (!conversation || !initialized) return;

    const interval = setInterval(async () => {
      try {
        const latest = await getMessages(conversation.id || conversation._id, {
          before: undefined,
          limit: 100,
          scope: admin ? 'admin' : 'customer',
        });
        setMessages(latest);
        await markAsRead(conversation.id || conversation._id, { scope: admin ? 'admin' : 'customer' });
      } catch {
        // Silent — polling errors should not disrupt the UI
      }
    }, 10000);

    return () => clearInterval(interval);
  }, [conversation, initialized]);

  const handleSend = async () => {
    if (!newMessage.trim() || sending || !conversation) return;

    setSending(true);
    setSendError('');
    try {
      const msg = await sendMessage(conversation.id || conversation._id, newMessage.trim(), { scope: admin ? 'admin' : 'customer' });
      setMessages((prev) => [...prev, msg]);
      setNewMessage('');
      textareaRef.current?.focus();
    } catch (err) {
      // The typed message stays in the composer — never silently lose input.
      setSendError(err.message || 'Your message could not be sent. Please try again.');
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  /* ── GSAP: thread entrance + message reveal (customer view only) ── */
  const threadRef = useRef(null);
  useEffect(() => {
    if (admin || prefersReduced || !threadRef.current) return;
    const ctx = gsap.context(() => {
      gsap.from(threadRef.current.querySelector('[data-conv-header]'), {
        y: 18, opacity: 0, duration: 0.55, ease: 'power3.out',
      });
      const bubbles = threadRef.current.querySelectorAll('[data-msg]');
      if (bubbles.length) {
        gsap.from(bubbles, { y: 10, opacity: 0, duration: 0.4, ease: 'power2.out', stagger: 0.05, clearProps: 'all' });
      }
      gsap.from(threadRef.current.querySelector('[data-composer]'), {
        y: 14, opacity: 0, duration: 0.5, delay: 0.15, ease: 'power3.out',
      });
    }, threadRef);
    return () => ctx.revert();
    // Only animate on first load of a conversation, not on every poll tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialized, conversation && (conversation.id || conversation._id)]);

  const handleStartConversation = async () => {
    try {
      setLoading(true);
      const convScope2 = admin ? 'admin' : 'customer';
      const conv = await getOrCreateConversation(effectiveOrderId, { scope: convScope2 });
      setConversation(conv);
      const msgs = await getMessages(conv.id || conv._id, { scope: convScope2 });
      setMessages(msgs);
      await markAsRead(conv.id || conv._id, { scope: convScope2 });
      setInitialized(true);
    } catch (err) {
      setError(err.message || 'Failed to start conversation.');
    } finally {
      setLoading(false);
    }
  };

  // Determine current user identity for own-message detection
  // We check which messages are from the current user by senderRole
  const isOwnMessage = (msg) => {
    if (admin) {
      return msg.senderRole === 'admin' || msg.senderRole === 'handler';
    }
    return msg.senderRole === 'customer';
  };

  // Back link
  const backLink = admin ? `/admin/orders/${effectiveOrderId}` : `/order-tracking/${effectiveOrderId}`;
  const backLabel = admin ? 'Back to Order' : 'Back to Order';

  if (loading && !initialized) {
    return (
      <div className={`${admin ? '' : 'min-h-screen bg-[#fcf9f4]'}`}>
        <div className={`${admin ? 'max-w-4xl mx-auto' : 'max-w-3xl mx-auto px-4 py-12'}`}>
          <div className="flex items-center justify-center h-64">
            <Loader2 className="w-6 h-6 text-[#964735] animate-spin" />
          </div>
        </div>
      </div>
    );
  }

  if (error && !conversation) {
    return (
      <div className={`${admin ? '' : 'min-h-screen bg-[#fcf9f4]'}`}>
        <div className={`${admin ? 'max-w-4xl mx-auto py-8' : 'max-w-3xl mx-auto px-4 py-12'}`}>
          <div className="bg-white rounded-3xl border border-[#e5e2dd] shadow-sm p-8 text-center">
            <AlertCircle className="w-10 h-10 text-[#c17c74] mx-auto mb-4" />
            <h3 className="font-serif text-[20px] text-[#180f0a] font-medium mb-2">Conversation Unavailable</h3>
            <p className="text-[14px] text-[#80756f] mb-6">{error}</p>
            <Link
              to={backLink}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-[#180f0a] text-white text-[13px] font-semibold hover:bg-[#2e241e] transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              {backLabel}
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (!conversation && initialized) {
    return (
      <div className={`${admin ? '' : 'min-h-screen bg-[#fcf9f4]'}`}>
        <div className={`${admin ? 'max-w-4xl mx-auto py-8' : 'max-w-3xl mx-auto px-4 py-12'}`}>
          <EmptyState onStartConversation={handleStartConversation} />
        </div>
      </div>
    );
  }

  return (
    <div className={`${admin ? '' : 'min-h-screen bg-[#fcf9f4]'}`}>
      <div ref={threadRef} className={`${admin ? 'max-w-4xl mx-auto py-8' : 'max-w-3xl mx-auto px-3 sm:px-4 py-6 sm:py-8'}`}>
        {/* Header */}
        <div data-conv-header className="bg-white rounded-3xl border border-[#e5e2dd] shadow-sm mb-3 sm:mb-4 overflow-hidden">
          <div className="px-4 sm:px-6 py-3 sm:py-4 border-b border-[#f0ede9]">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5 sm:gap-3">
                <Link
                  to={backLink}
                  className="w-9 h-9 rounded-full bg-[#f6f3ee] flex items-center justify-center hover:bg-[#ede9e4] transition-colors touch-target"
                >
                  <ArrowLeft className="w-4 h-4 text-[#4e4540]" />
                </Link>
                <div>
                  <h1 className="font-serif text-[16px] sm:text-[18px] text-[#180f0a] font-medium">
                    Order #{effectiveOrderId}
                  </h1>
                  <p className="text-[11px] sm:text-[12px] text-[#80756f]">
                    {order ? `Status: ${getStatusLabel(order.orderStatus)}` : 'Loading...'}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-500" aria-hidden="true" />
                <span className="text-[11px] sm:text-[12px] text-[#80756f] hidden sm:inline">Messages stored with your order</span>
              </div>
            </div>
          </div>
        </div>

        {/* Messages */}
        <div className="bg-white rounded-3xl border border-[#e5e2dd] shadow-sm overflow-hidden">
          <div className="h-[55vh] sm:h-[50vh] overflow-y-auto px-4 sm:px-6 py-3 sm:py-4" style={{ scrollBehavior: 'smooth' }}>
            {messages.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-center">
                <MessageSquare className="w-8 h-8 text-[#d9d3cc] mb-3" />
                <p className="text-[14px] text-[#80756f]">No messages yet.</p>
                <p className="text-[12px] text-[#b0a89f] mt-1">Send a message to start the conversation.</p>
              </div>
            ) : (
              <>
                <div aria-live="polite" aria-label="Conversation messages">
                  {messages.map((msg, idx) => (
                    <div key={msg._id || idx} data-msg>
                      <MessageBubble
                        message={msg}
                        isOwn={isOwnMessage(msg)}
                      />
                    </div>
                  ))}
                </div>
                <div ref={messagesEndRef} />
              </>
            )}
          </div>

          {/* Composer */}
          <div data-composer className="border-t border-[#f0ede9] px-4 sm:px-6 py-3 sm:py-4">
            {sendError && (
              <div role="alert" className="mb-3 flex items-start gap-2 px-3.5 py-2.5 rounded-xl bg-red-50 border border-red-200 text-[12px] text-red-700">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
                <span>{sendError} Your draft is preserved — press send to retry.</span>
              </div>
            )}
            {conversation?.status === 'closed' ? (
              <div className="text-center py-3">
                <p className="text-[13px] text-[#80756f]">This conversation is closed.</p>
              </div>
            ) : (
              <div className="flex items-end gap-2 sm:gap-3">
                <textarea
                  ref={textareaRef}
                  value={newMessage}
                  onChange={(e) => setNewMessage(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Type your message..."
                  rows={1}
                  className="flex-1 resize-none rounded-2xl border border-[#e5e2dd] bg-[#faf8f5] px-3 sm:px-4 py-2.5 sm:py-3 text-[14px] text-[#180f0a] placeholder-[#b0a89f] focus:outline-none focus:ring-2 focus:ring-[#c17c74]/30 focus:border-[#c17c74] transition-all min-h-[44px] max-h-[120px]"
                  style={{ fieldSizing: 'content' }}
                  disabled={sending}
                  aria-label="Message input"
                />
                <button
                  onClick={handleSend}
                  disabled={!newMessage.trim() || sending}
                  className="w-11 h-11 rounded-full bg-[#964735] text-white flex items-center justify-center hover:bg-[#7d3a2b] transition-colors disabled:opacity-40 disabled:cursor-not-allowed shadow-sm shrink-0 touch-target"
                  aria-label="Send message"
                >
                  {sending ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Send className="w-4 h-4" />
                  )}
                </button>
              </div>
            )}
            <p className="text-[11px] text-[#b0a89f] mt-2 text-center">
              Messages are stored with your order. Responses are handled by the Flora Alchemy team.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
