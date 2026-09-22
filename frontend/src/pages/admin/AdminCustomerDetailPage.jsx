import React, { useMemo } from 'react';
import { useStoreVersion } from '../../hooks/useStoreVersion.js';
import { useParams, Link } from 'react-router-dom';
import AdminLayout from '../../components/admin/AdminLayout.jsx';
import { getCustomerById, getCustomers } from '../../services/customerService.js';
import { getOrdersByCustomer, formatINR, formatDate, ORDER_STATUS_STYLES, ORDER_STATUSES } from '../../services/orderService.js';
import { isRevenue } from '../../services/analyticsService.js';

export default function AdminCustomerDetailPage() {
  const { customerId } = useParams();
  const storeVersion = useStoreVersion();
  const customer = useMemo(() => getCustomerById(customerId), [customerId, storeVersion]);
  const customerOrders = useMemo(() => getOrdersByCustomer(customerId), [customerId, storeVersion]);
  const revenueOrders = useMemo(() => customerOrders.filter(isRevenue), [customerOrders]);

  if (!customer) {
    return (
      <AdminLayout>
        <div className="max-w-7xl mx-auto pb-12">
          <div className="p-12 sm:p-16 bg-[var(--color-surface-lowest)] rounded-2xl text-center space-y-4 shadow-xs border border-[var(--color-botanical-border)]">
            <div className="w-16 h-16 rounded-full bg-[var(--color-surface-low)] mx-auto flex items-center justify-center text-[var(--color-botanical-subtle)]">
              <span className="material-symbols-outlined text-[32px]">search_off</span>
            </div>
            <div className="max-w-md mx-auto">
              <h3 className="font-serif text-2xl text-[var(--color-botanical-primary)] font-medium">Customer Not Found</h3>
              <p className="text-[14px] text-[var(--color-botanical-muted)] mt-1.5">The customer "{customerId}" does not exist in the system.</p>
            </div>
            <Link to="/admin/customers" className="inline-block px-5 py-2 rounded-full bg-[var(--color-btn)] text-white text-[13px] font-semibold shadow-xs hover:bg-[var(--color-btn-hover-alt)] transition-colors">Return to Customers</Link>
          </div>
        </div>
      </AdminLayout>
    );
  }

  const totalSpend = revenueOrders.reduce((s, o) => s + o.total, 0);

  return (
    <AdminLayout>
      <div className="max-w-7xl mx-auto space-y-6 pb-12">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Link to="/admin/customers" className="p-2 rounded-xl hover:bg-[var(--color-surface-high)] text-[var(--color-botanical-muted)] transition-colors">
              <span className="material-symbols-outlined text-[20px]">arrow_back</span>
            </Link>
            <div>
              <h1 className="font-serif text-2xl sm:text-3xl text-[var(--color-botanical-primary)] tracking-tight font-normal">{customer.name}</h1>
              <p className="text-[13px] text-[var(--color-botanical-subtle)] mt-0.5">{customer.id} · {customer.email}</p>
            </div>
          </div>
        </div>

        {/* Customer Metrics */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3.5">
          <div className="bg-[var(--color-surface-lowest)] p-4 rounded-xl border border-[var(--color-botanical-border)] shadow-xs">
            <div className="flex items-center justify-between text-[var(--color-botanical-subtle)] mb-1.5"><span className="text-[11px] uppercase tracking-wider font-semibold">Total Orders</span><span className="material-symbols-outlined text-[16px]">shopping_bag</span></div>
            <div className="text-3xl font-serif font-medium text-[var(--color-botanical-primary)] leading-none">{revenueOrders.length}</div>
          </div>
          <div className="bg-[var(--color-surface-lowest)] p-4 rounded-xl border border-[var(--color-botanical-border)] shadow-xs">
            <div className="flex items-center justify-between text-[var(--color-botanical-subtle)] mb-1.5"><span className="text-[11px] uppercase tracking-wider font-semibold">Total Spend</span><span className="material-symbols-outlined text-[16px] text-[var(--color-botanical-primary)]">payments</span></div>
            <div className="text-3xl font-serif font-medium text-[var(--color-botanical-primary)] leading-none">{formatINR(totalSpend)}</div>
          </div>
          <div className="bg-[var(--color-surface-lowest)] p-4 rounded-xl border border-[var(--color-botanical-border)] shadow-xs">
            <div className="flex items-center justify-between text-[var(--color-botanical-subtle)] mb-1.5"><span className="text-[11px] uppercase tracking-wider font-semibold">Avg. Order</span><span className="material-symbols-outlined text-[16px] text-[var(--color-accent)]">trending_up</span></div>
            <div className="text-3xl font-serif font-medium text-[var(--color-botanical-primary)] leading-none">{revenueOrders.length > 0 ? formatINR(Math.round(totalSpend / revenueOrders.length)) : '₹0'}</div>
          </div>
          <div className="bg-[var(--color-surface-lowest)] p-4 rounded-xl border border-[var(--color-botanical-border)] shadow-xs">
            <div className="flex items-center justify-between text-[var(--color-botanical-subtle)] mb-1.5"><span className="text-[11px] uppercase tracking-wider font-semibold">Status</span></div>
            <div className="mt-2">
              <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[12px] font-bold ${customer.status === 'Active' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300 border border-emerald-200' : 'bg-[var(--color-surface-low)] text-[var(--color-botanical-subtle)] border border-[var(--color-botanical-border)]'}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${customer.status === 'Active' ? 'bg-emerald-600' : 'bg-[#80756f]'}`}></span>
                {customer.status}
              </span>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Profile Card */}
          <div className="space-y-6">
            <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] p-6 shadow-xs">
              <h2 className="font-serif text-lg text-[var(--color-botanical-primary)] font-medium mb-4">Profile</h2>
              <div className="flex items-center gap-4 mb-4">
                <div className="w-14 h-14 rounded-full bg-[var(--color-btn)] text-white flex items-center justify-center font-semibold text-[16px]">
                  {customer.name.split(' ').map(w => w[0]).join('').slice(0, 2)}
                </div>
                <div>
                  <p className="font-semibold text-[var(--color-botanical-primary)] text-[15px]">{customer.name}</p>
                  <p className="text-[12px] text-[var(--color-botanical-subtle)]">{customer.id}</p>
                </div>
              </div>
              <div className="space-y-2.5 text-[13px]">
                <div className="flex items-center gap-2"><span className="material-symbols-outlined text-[16px] text-[var(--color-botanical-subtle)]">email</span><span className="text-[var(--color-botanical-muted)]">{customer.email}</span></div>
                <div className="flex items-center gap-2"><span className="material-symbols-outlined text-[16px] text-[var(--color-botanical-subtle)]">phone</span><span className="text-[var(--color-botanical-muted)]">{customer.phone}</span></div>
                <div className="flex items-center gap-2"><span className="material-symbols-outlined text-[16px] text-[var(--color-botanical-subtle)]">location_on</span><span className="text-[var(--color-botanical-muted)]">{customer.city}, {customer.state}</span></div>
                <div className="flex items-center gap-2"><span className="material-symbols-outlined text-[16px] text-[var(--color-botanical-subtle)]">calendar_today</span><span className="text-[var(--color-botanical-muted)]">Customer since {formatDate(customer.createdAt)}</span></div>
              </div>
            </div>

            <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] p-6 shadow-xs">
              <h2 className="font-serif text-lg text-[var(--color-botanical-primary)] font-medium mb-3">Shipping Address</h2>
              <div className="text-[13px] text-[var(--color-botanical-muted)] space-y-1">
                <p className="font-medium text-[var(--color-botanical-primary)]">{customer.name}</p>
                <p>{customer.address}</p>
                <p>{customer.city}, {customer.state}</p>
                <p>{customer.phone}</p>
              </div>
            </div>
          </div>

          {/* Order History */}
          <div className="lg:col-span-2">
            <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] p-6 shadow-xs">
              <h2 className="font-serif text-lg text-[var(--color-botanical-primary)] font-medium mb-4">Order History</h2>
              {customerOrders.length === 0 ? (
                <p className="text-[13px] text-[var(--color-botanical-subtle)] py-8 text-center">No orders found for this customer.</p>
              ) : (
                <div className="divide-y divide-[var(--color-divider)]">
                  {customerOrders.map(order => {
                    const style = ORDER_STATUS_STYLES[order.orderStatus] || ORDER_STATUS_STYLES.new;
                    const statusObj = ORDER_STATUSES.find(s => s.key === order.orderStatus);
                    return (
                      <Link key={order.id} to={`/admin/orders/${order.id}`} className="flex items-center justify-between py-3 hover:bg-[var(--color-surface-low)]/50 transition-colors -mx-2 px-2 rounded-lg">
                        <div className="flex items-center gap-3">
                          <span className="font-mono font-semibold text-[var(--color-botanical-primary)] text-[13px]">#{order.id}</span>
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold ${style.bg} ${style.text} border ${style.border}`}>
                            {statusObj?.label}
                          </span>
                        </div>
                        <div className="text-right">
                          <span className="font-mono font-semibold text-[var(--color-botanical-primary)] text-[13px]">{formatINR(order.total)}</span>
                          <p className="text-[11px] text-[var(--color-botanical-subtle)]">{formatDate(order.createdAt)}</p>
                        </div>
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
