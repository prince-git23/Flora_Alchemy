import React from 'react';
import {
  ORDER_STATUSES,
  getCustomerFacingStatus,
  getStatusStage,
  getStatusLabel,
} from '../services/orderService.js';

const STEP_ICONS = ['🛒', '✉️', '✂️', '🔍', '📦', '🚚', '🏡'];

/**
 * Renders the canonical Flora Alchemy order lifecycle:
 * new → confirmed → in_production → quality_check → ready_to_dispatch → shipped → delivered
 *
 * Desktop: horizontal step rail
 * Mobile: vertical timeline with clear current status
 */
export default function OrderStatusTracker({ order }) {
  if (!order) return null;

  const currentStage = getStatusStage(order.orderStatus || 'new');
  const currentLabel = getCustomerFacingStatus(order.orderStatus || 'new');
  const rawLabel = getStatusLabel(order.orderStatus || 'new');

  return (
    <div>
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-[var(--color-botanical-border)] pb-5">
        <div>
          <p className="text-[12px] font-bold text-[#964735]">Order #{order.id || order.orderId}</p>
          <p className="text-[11px] text-[var(--color-botanical-subtle)]">
            Status · <span className="font-bold uppercase text-[#964735]">{rawLabel}</span>
          </p>
        </div>
        <div className="text-left sm:text-right">
          <p className="text-[13px] font-semibold text-[var(--color-botanical-primary)]">
            Current stage: <span className="text-[#964735]">{currentLabel}</span>
          </p>
          {order.trackingNumber && (
            <p className="text-[12px] text-[var(--color-botanical-subtle)]">
              Tracking: <span className="font-mono font-bold text-[var(--color-botanical-primary)]">{order.trackingNumber}</span>
            </p>
          )}
        </div>
      </div>

      {/* ── Desktop: Horizontal Step Rail ── */}
      <div className="hidden sm:block py-6">
        <div className="relative">
          <div className="absolute left-0 top-[15px] h-1 bg-[#ebe8e3] w-full z-0 rounded-full" />
          <div
            className="absolute left-0 top-[15px] h-1 bg-[#964735] transition-all duration-700 z-0 rounded-full"
            style={{ width: `${Math.max(0, ((currentStage - 1) / (ORDER_STATUSES.length - 1)) * 100)}%` }}
          />
          <div className="relative z-10 grid grid-cols-7 gap-1">
            {ORDER_STATUSES.map((step, idx) => {
              const stageNum = idx + 1;
              const done = currentStage >= stageNum;
              const isCurrent = currentStage === stageNum;
              return (
                <div key={step.key} className="flex flex-col items-center text-center px-1">
                  <div
                    className={`w-[30px] h-[30px] rounded-full flex items-center justify-center text-[13px] shadow-sm ${
                      done ? (isCurrent ? 'bg-[#964735] text-white fa-tracker-pulse' : 'bg-[#180f0a] text-white') : 'bg-[#ebe8e3] text-[var(--color-botanical-muted)]'
                    }`}
                    aria-hidden="true"
                  >
                    {done && !isCurrent ? '✓' : STEP_ICONS[idx]}
                  </div>
                  <span className={`text-[10px] mt-2 leading-tight ${done ? 'font-bold text-[var(--color-botanical-primary)]' : 'text-[var(--color-botanical-subtle)]'}`}>
                    {getCustomerFacingStatus(step.key)}
                  </span>
                  {idx === 0 && (
                    <span className="text-[9px] text-[#a89f99] hidden lg:block">{step.description}</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── Mobile: Vertical Timeline ── */}
      <div className="sm:hidden py-4">
        <ol className="relative border-l border-[var(--color-botanical-border)] ml-2 space-y-3">
          {ORDER_STATUSES.map((step, idx) => {
            const stageNum = idx + 1;
            const done = currentStage >= stageNum;
            const isCurrent = currentStage === stageNum;
            return (
              <li key={step.key} className="ml-4 pl-1 flex items-start gap-3">
                <span
                  className={`absolute -left-[5px] w-3 h-3 rounded-full mt-1 shrink-0 ${
                    isCurrent ? 'bg-[#964735] ring-4 ring-[#ffdad3]/50 fa-tracker-pulse'
                    : done ? 'bg-[#180f0a]'
                    : 'bg-[#ebe8e3]'
                  }`}
                  aria-hidden="true"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[14px]" aria-hidden="true">{STEP_ICONS[idx]}</span>
                    <span className={`text-[13px] font-semibold ${done ? 'text-[var(--color-botanical-primary)]' : 'text-[var(--color-botanical-subtle)]'}`}>
                      {getCustomerFacingStatus(step.key)}
                    </span>
                    {isCurrent && (
                      <span className="px-2 py-0.5 rounded-full bg-[#ffdad3] text-[#964735] text-[10px] font-bold uppercase tracking-wide">
                        Current
                      </span>
                    )}
                  </div>
                  {done && !isCurrent && (
                    <span className="text-[11px] text-[#5b6d54] font-medium">Completed</span>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
