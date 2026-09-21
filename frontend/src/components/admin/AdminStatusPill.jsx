import React from 'react';
import {
  Clock, BadgeCheck, Hammer, Search, PackageCheck, Truck, Home,
  CircleDashed, Quote, CheckCircle2, XCircle, MessageCircle,
} from 'lucide-react';

/**
 * AdminStatusPill — canonical status visual language for the Handler Portal.
 *
 * Icon + label + tint so state is never color-only. Values are strictly
 * limited to backend enums:
 *  — Order: new | confirmed | in_production | quality_check |
 *           ready_to_dispatch | shipped | delivered
 *  — Request: pending | reviewing | quoted | accepted | declined
 *  — Conversation: open | closed
 * Mirrors the customer-facing StatusPill contract (Prompt 6).
 */

const ORDER_META = {
  new: { icon: Clock, label: 'New', tint: 'bg-purple-50 text-purple-800 ring-purple-200' },
  confirmed: { icon: BadgeCheck, label: 'Confirmed', tint: 'bg-slate-100 text-slate-800 ring-slate-200' },
  in_production: { icon: Hammer, label: 'In Production', tint: 'bg-[#ffdad3] text-[#783020] ring-[#edd1cc]' },
  quality_check: { icon: Search, label: 'Quality Check', tint: 'bg-amber-50 text-amber-900 ring-amber-200' },
  ready_to_dispatch: { icon: PackageCheck, label: 'Ready to Dispatch', tint: 'bg-emerald-100 text-emerald-800 ring-emerald-200' },
  shipped: { icon: Truck, label: 'Shipped', tint: 'bg-sky-50 text-sky-800 ring-sky-200' },
  delivered: { icon: Home, label: 'Delivered', tint: 'bg-stone-100 text-stone-700 ring-stone-200' },
};

const REQUEST_META = {
  pending: { icon: CircleDashed, label: 'Pending', tint: 'bg-[var(--color-surface-container)] text-[var(--color-botanical-muted)] ring-[#e5e2dd]' },
  reviewing: { icon: Search, label: 'Reviewing', tint: 'bg-amber-50 text-amber-900 ring-amber-200' },
  quoted: { icon: Quote, label: 'Quoted', tint: 'bg-sky-50 text-sky-800 ring-sky-200' },
  accepted: { icon: CheckCircle2, label: 'Accepted', tint: 'bg-emerald-100 text-emerald-800 ring-emerald-200' },
  declined: { icon: XCircle, label: 'Declined', tint: 'bg-red-50 text-red-700 ring-red-200' },
};

const CONVERSATION_META = {
  open: { icon: MessageCircle, label: 'Open', tint: 'bg-emerald-100 text-emerald-800 ring-emerald-200' },
  closed: { icon: CheckCircle2, label: 'Closed', tint: 'bg-stone-100 text-stone-700 ring-stone-200' },
};

const PAYMENT_META = {
  Paid: { icon: CheckCircle2, tint: 'bg-emerald-50 text-emerald-800 ring-emerald-200' },
  Pending: { icon: Clock, tint: 'bg-amber-50 text-amber-800 ring-amber-200' },
  Failed: { icon: XCircle, tint: 'bg-red-50 text-red-700 ring-red-200' },
  Refunded: { icon: Quote, tint: 'bg-stone-100 text-stone-700 ring-stone-200' },
  Sample: { icon: CircleDashed, tint: 'bg-purple-50 text-purple-800 ring-purple-200' },
};

function Pill({ meta, status, size = 'sm', pulse = false, className = '' }) {
  if (!meta) return null;
  const Icon = meta.icon;
  const pad = size === 'lg' ? 'px-3 py-1 text-[12px]' : 'px-2 py-0.5 text-[10px]';
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full ${meta.tint} ring-1 ${pad} font-bold uppercase tracking-wide whitespace-nowrap ${className}`}
      data-status={status}
    >
      <Icon className={`${size === 'lg' ? 'w-3.5 h-3.5' : 'w-3 h-3'} ${pulse ? 'animate-pulse' : ''}`} aria-hidden="true" />
      <span>{meta.label}</span>
    </span>
  );
}

export function AdminOrderStatusPill({ status, size = 'sm', className = '' }) {
  return <Pill meta={ORDER_META[status]} status={status} size={size} pulse={status === 'in_production'} className={className} />;
}

export function AdminRequestStatusPill({ status, size = 'sm', className = '' }) {
  return <Pill meta={REQUEST_META[status]} status={status} size={size} className={className} />;
}

export function AdminConversationStatusPill({ status, className = '' }) {
  return <Pill meta={CONVERSATION_META[status]} status={status} size="sm" className={className} />;
}

export function AdminPaymentStatusPill({ status, className = '' }) {
  return <Pill meta={PAYMENT_META[status]} status={status} size="sm" className={className} />;
}
