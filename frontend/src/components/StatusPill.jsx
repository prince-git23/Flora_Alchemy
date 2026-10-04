import React from 'react';
import { Clock, Search, Hammer, BadgeCheck, PackageCheck, Truck, Home, FileText, MessageCircle, Quote, CheckCircle2, XCircle, CircleDashed, CreditCard } from 'lucide-react';

/**
 * StatusPill — canonical visual language for customer-facing statuses.
 *
 * Every status carries an icon + label + distinct tint so state is never
 * communicated by color alone (accessibility contract, Prompt 6 Part 20).
 * Values are strictly limited to backend enums:
 *  — Order:  new | confirmed | in_production | quality_check |
 *            ready_to_dispatch | shipped | delivered
 *  — Request: pending | reviewing | accepted | quoted | payment_pending |
 *             paid | in_progress | completed | declined | customer_declined
 *  — Conversation: open | closed
 */

const ORDER_STATUS_META = {
  new: { icon: Clock, label: 'Order Received', tint: 'bg-purple-50 text-purple-800 dark:bg-purple-500/15 dark:text-purple-300', ring: 'ring-purple-200' },
  confirmed: { icon: BadgeCheck, label: 'Confirmed', tint: 'bg-slate-100 text-slate-800 dark:bg-slate-500/15 dark:text-slate-300', ring: 'ring-slate-200' },
  in_production: { icon: Hammer, label: 'Being Crafted', tint: 'bg-[var(--color-badge-bg)] text-[var(--color-badge-fg-strong)]', ring: 'ring-[#edd1cc]' },
  quality_check: { icon: Search, label: 'Quality Check', tint: 'bg-amber-50 text-amber-900 dark:bg-amber-500/15 dark:text-amber-300', ring: 'ring-amber-200' },
  ready_to_dispatch: { icon: PackageCheck, label: 'Ready for Dispatch', tint: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300', ring: 'ring-emerald-200' },
  shipped: { icon: Truck, label: 'Shipped', tint: 'bg-sky-50 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300', ring: 'ring-sky-200' },
  delivered: { icon: Home, label: 'Delivered', tint: 'bg-stone-100 text-stone-700 dark:bg-stone-500/15 dark:text-stone-300', ring: 'ring-stone-200' },
};

const REQUEST_STATUS_META = {
  pending: { icon: CircleDashed, label: 'Pending', tint: 'bg-[var(--color-surface-container)] text-[var(--color-botanical-muted)]', ring: 'ring-[var(--color-botanical-border)]' },
  reviewing: { icon: Search, label: 'In Review', tint: 'bg-amber-50 text-amber-900 dark:bg-amber-500/15 dark:text-amber-300', ring: 'ring-amber-200' },
  accepted: { icon: CheckCircle2, label: 'Accepted', tint: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300', ring: 'ring-emerald-200' },
  quoted: { icon: Quote, label: 'Proposal Sent', tint: 'bg-sky-50 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300', ring: 'ring-sky-200' },
  payment_pending: { icon: CreditCard, label: 'Payment Due', tint: 'bg-indigo-50 text-indigo-800 dark:bg-indigo-500/15 dark:text-indigo-300', ring: 'ring-indigo-200' },
  paid: { icon: BadgeCheck, label: 'Paid', tint: 'bg-emerald-50 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300', ring: 'ring-emerald-200' },
  in_progress: { icon: Hammer, label: 'Being Crafted', tint: 'bg-[var(--color-badge-bg)] text-[var(--color-badge-fg-strong)]', ring: 'ring-[#edd1cc]' },
  completed: { icon: PackageCheck, label: 'Completed', tint: 'bg-stone-100 text-stone-700 dark:bg-stone-500/15 dark:text-stone-300', ring: 'ring-stone-200' },
  declined: { icon: XCircle, label: 'Declined', tint: 'bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-300', ring: 'ring-red-200' },
  customer_declined: { icon: XCircle, label: 'Proposal Declined', tint: 'bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-300', ring: 'ring-red-200' },
};

const CONVERSATION_STATUS_META = {
  open: { icon: MessageCircle, label: 'Open', tint: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300', ring: 'ring-emerald-200' },
  closed: { icon: CheckCircle2, label: 'Closed', tint: 'bg-stone-100 text-stone-700 dark:bg-stone-500/15 dark:text-stone-300', ring: 'ring-stone-200' },
};

const REQUEST_NOTE = {
  pending: 'Our studio has received your request and will review it shortly.',
  reviewing: 'Our studio is reviewing the details of your request.',
  accepted: 'Your request has been accepted — our studio is preparing your custom proposal.',
  quoted: 'Your custom proposal is ready for you to review.',
  payment_pending: 'Your proposal is accepted — complete the payment to begin fulfillment.',
  paid: 'Payment received. Our studio will begin crafting your gift.',
  in_progress: 'Our studio is crafting your custom gift.',
  completed: 'Your custom gift is complete.',
  declined: 'Unfortunately this request could not be taken forward at this time.',
  customer_declined: 'You declined the proposal for this request.',
};

export function OrderStatusPill({ status, size = 'sm', className = '' }) {
  const meta = ORDER_STATUS_META[status] || ORDER_STATUS_META.new;
  const Icon = meta.icon;
  const pad = size === 'lg' ? 'px-3.5 py-1.5 text-[12px]' : 'px-2.5 py-1 text-[11px]';
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full ${meta.tint} ${pad} font-bold uppercase tracking-wide ring-1 ${meta.ring} ${className}`}
      data-order-status={status}
    >
      <Icon className={size === 'lg' ? 'w-3.5 h-3.5' : 'w-3 h-3'} aria-hidden="true" />
      <span>{meta.label}</span>
    </span>
  );
}

export function RequestStatusPill({ status, size = 'sm', className = '' }) {
  const meta = REQUEST_STATUS_META[status] || REQUEST_STATUS_META.pending;
  const Icon = meta.icon;
  const pad = size === 'lg' ? 'px-3.5 py-1.5 text-[12px]' : 'px-2.5 py-1 text-[11px]';
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full ${meta.tint} ${pad} font-bold uppercase tracking-wide ring-1 ${meta.ring} ${className}`}
      data-request-status={status}
    >
      <Icon className={size === 'lg' ? 'w-3.5 h-3.5' : 'w-3 h-3'} aria-hidden="true" />
      <span>{meta.label}</span>
    </span>
  );
}

export function ConversationStatusPill({ status, className = '' }) {
  const meta = CONVERSATION_STATUS_META[status] || CONVERSATION_STATUS_META.open;
  const Icon = meta.icon;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full ${meta.tint} px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide ring-1 ${meta.ring} ${className}`}
    >
      <Icon className="w-3 h-3" aria-hidden="true" />
      <span>{meta.label}</span>
    </span>
  );
}

export function requestStatusNote(status) {
  return REQUEST_NOTE[status] || 'Our studio is looking after your request.';
}
