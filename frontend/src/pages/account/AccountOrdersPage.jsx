import React from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { Package, ArrowRight, Truck } from 'lucide-react';
import { useStoreVersion } from '../../hooks/useStoreVersion.js';
import { getOrdersByCustomer, getCustomerFacingStatus, formatDate, formatINR } from '../../services/orderService.js';

/**
 * MY ORDERS — the customer's own order history.
 *
 * Reads the identity-scoped store slice (hydrated from GET /api/orders/mine),
 * so only this customer's orders can ever be shown. No operational controls, no
 * staff notes, no inventory: an order row names what was bought and where it is.
 */
export default function AccountOrdersPage() {
  useStoreVersion();
  const { profile, account } = useOutletContext();
  const customerId = (profile && (profile.id || profile._id)) || (account && account.customerId) || null;
  const orders = customerId ? getOrdersByCustomer(customerId) : [];

  if (orders.length === 0) {
    return (
      <section className="space-y-6">
        <SectionHeading
          eyebrow="Order history"
          title="Your Orders"
          subtitle="Every handcrafted piece you’ve ordered from the studio, in one place."
        />
        <div className="relative bg-[var(--color-surface-lowest)] rounded-3xl p-10 sm:p-14 text-center border border-[var(--color-botanical-border)] overflow-hidden">
          <div className="absolute -top-14 -right-14 w-40 h-40 rounded-full bg-[var(--color-badge-bg)]/10 blur-3xl pointer-events-none" />
          <div className="relative w-14 h-14 rounded-full bg-[var(--color-surface-low)] mx-auto flex items-center justify-center">
            <Package className="w-6 h-6 text-[var(--color-accent)]" />
          </div>
          <h2 className="relative font-serif text-[22px] text-[var(--color-botanical-primary)] mt-4">
            No orders yet
          </h2>
          <p className="relative text-[14px] text-[var(--color-botanical-muted)] mt-2 max-w-md mx-auto">
            Your handcrafted floral orders will appear here the moment you place one.
          </p>
          <Link
            to="/shop"
            className="relative inline-flex items-center gap-2 mt-6 px-7 py-3 rounded-full bg-[var(--color-btn)] text-white text-[13px] font-semibold hover:bg-[var(--color-btn-hover)] transition-colors"
          >
            Explore the collection <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-6">
      <SectionHeading
        eyebrow="Order history"
        title="Your Orders"
        subtitle={`${orders.length} order${orders.length > 1 ? 's' : ''} with the studio.`}
      />

      <ul className="space-y-4">
        {orders.map((order) => {
          const orderId = order.orderId || order.id;
          const items = order.items || [];
          const itemCount = items.reduce((n, i) => n + (Number(i.quantity) || 1), 0);
          const leadItem = items[0];
          const extra = items.length - 1;
          return (
            <li key={orderId}>
              <Link
                to={`/order-tracking/${orderId}`}
                className="group block bg-[var(--color-surface-lowest)] rounded-3xl p-5 sm:p-6 border border-[var(--color-botanical-border)] hover:border-[var(--color-accent)] hover:shadow-md transition-all"
              >
                <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-[var(--color-botanical-border)]">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="text-[14px] font-bold text-[var(--color-botanical-primary)]">
                      #{orderId}
                    </span>
                    <span className="text-[12px] text-[var(--color-botanical-subtle)]">
                      {formatDate(order.createdAt || order.date)}
                    </span>
                  </div>
                  <span className="px-3 py-1 rounded-full bg-[var(--color-badge-bg)] text-[var(--color-badge-fg)] text-[10px] font-bold uppercase tracking-wider">
                    {getCustomerFacingStatus(order.orderStatus || order.status || 'new')}
                  </span>
                </div>

                <div className="flex items-center justify-between gap-4 pt-4">
                  <div className="flex items-center gap-3 min-w-0">
                    {leadItem?.image && (
                      <img
                        loading="lazy"
                        decoding="async"
                        src={leadItem.image}
                        alt={leadItem.name || 'Ordered piece'}
                        className="w-14 h-14 rounded-2xl object-cover border border-[var(--color-botanical-border)] shrink-0"
                      />
                    )}
                    <div className="min-w-0">
                      <p className="font-serif text-[15px] text-[var(--color-botanical-primary)] font-medium truncate">
                        {leadItem?.name || 'Floral arrangement'}
                      </p>
                      <p className="text-[12px] text-[var(--color-botanical-subtle)]">
                        {itemCount} item{itemCount === 1 ? '' : 's'}
                        {extra > 0 ? ` · +${extra} more` : ''}
                      </p>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-[15px] font-bold text-[var(--color-botanical-primary)]">
                      {formatINR(order.total || 0)}
                    </p>
                    <span className="inline-flex items-center gap-1 text-[12px] font-semibold text-[var(--color-accent)] mt-1">
                      <Truck className="w-3.5 h-3.5" /> View order
                    </span>
                  </div>
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function SectionHeading({ eyebrow, title, subtitle }) {
  return (
    <div className="space-y-1">
      <span className="block text-[11px] font-bold uppercase tracking-widest text-[var(--color-accent)]">
        {eyebrow}
      </span>
      <h2 className="font-serif text-[26px] sm:text-[30px] text-[var(--color-botanical-primary)] font-normal tracking-tight">
        {title}
      </h2>
      {subtitle && <p className="text-[14px] text-[var(--color-botanical-muted)]">{subtitle}</p>}
    </div>
  );
}
