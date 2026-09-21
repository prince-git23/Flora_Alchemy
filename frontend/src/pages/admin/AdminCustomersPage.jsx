import React, { useState, useMemo } from 'react';
import { useStoreVersion } from '../../hooks/useStoreVersion.js';
import { Link } from 'react-router-dom';
import AdminLayout from '../../components/admin/AdminLayout.jsx';
import { getCustomers, getCustomerById } from '../../services/customerService.js';
import { getOrders, formatINR, formatDate } from '../../services/orderService.js';
import { isRevenue } from '../../services/analyticsService.js';

export default function AdminCustomersPage() {
  const storeVersion = useStoreVersion();
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  // Live MongoDB customers only — static sample records are never merged in.
  const allCustomers = useMemo(() => getCustomers(), [storeVersion]);

  const orders = useMemo(() => getOrders(), [storeVersion]);

  const customersWithMetrics = useMemo(() => {
    const revenueOrders = orders.filter(isRevenue);
    return allCustomers.map(c => {
      const customerOrders = revenueOrders.filter(o => o.customerId === c.id);
      return { ...c, orderCount: customerOrders.length, totalSpend: customerOrders.reduce((s, o) => s + o.total, 0) };
    });
  }, [allCustomers, orders]);

  const filtered = useMemo(() => {
    let list = [...customersWithMetrics];
    if (statusFilter !== 'all') list = list.filter(c => c.status.toLowerCase() === statusFilter);
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(c => c.name.toLowerCase().includes(q) || c.email.toLowerCase().includes(q) || c.id.toLowerCase().includes(q));
    }
    return list;
  }, [customersWithMetrics, statusFilter, searchQuery]);

  const totalCustomers = customersWithMetrics.length;
  const activeCustomers = customersWithMetrics.filter(c => c.status === 'Active').length;
  const totalRevenue = customersWithMetrics.reduce((s, c) => s + c.totalSpend, 0);
  const avgSpend = totalCustomers > 0 ? Math.round(totalRevenue / totalCustomers) : 0;

  const handleExportCSV = () => {
    const rows = [['Customer ID', 'Name', 'Email', 'Phone', 'City', 'Status', 'Orders', 'Total Spend']];
    filtered.forEach(c => rows.push([c.id, c.name, c.email, c.phone, c.city, c.status, c.orderCount, c.totalSpend]));
    const csv = rows.map(r => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'flora_alchemy_customers.csv';
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <AdminLayout>
      <div className="max-w-7xl mx-auto space-y-6 pb-12">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="font-serif text-3xl sm:text-4xl text-[var(--color-botanical-primary)] tracking-tight font-normal">Customers</h1>
            <p className="text-[14px] text-[var(--color-botanical-muted)] mt-1">Manage customer profiles, order history, and engagement</p>
          </div>
          <div className="flex items-center gap-2.5">
            <button type="button" onClick={handleExportCSV} className="inline-flex items-center gap-2 px-3.5 py-2 text-[12px] font-medium text-[var(--color-botanical-text)] bg-[var(--color-surface-lowest)] hover:bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] rounded-full transition shadow-xs">
              <span className="material-symbols-outlined text-[16px]">download</span>
              Export CSV
            </button>
          </div>
        </div>

        {/* KPI */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3.5">
          <div className="bg-[var(--color-surface-lowest)] p-4 rounded-xl border border-[var(--color-botanical-border)] shadow-xs">
            <div className="flex items-center justify-between text-[var(--color-botanical-subtle)] mb-1.5"><span className="text-[11px] uppercase tracking-wider font-semibold">Total Customers</span><span className="material-symbols-outlined text-[16px]">group</span></div>
            <div className="text-3xl font-serif font-medium text-[var(--color-botanical-primary)] leading-none">{totalCustomers}</div>
          </div>
          <div className="bg-[var(--color-surface-lowest)] p-4 rounded-xl border border-[var(--color-botanical-border)] shadow-xs">
            <div className="flex items-center justify-between text-[var(--color-botanical-subtle)] mb-1.5"><span className="text-[11px] uppercase tracking-wider font-semibold">Active</span><span className="material-symbols-outlined text-[16px] text-[#5b6d54]">check_circle</span></div>
            <div className="text-3xl font-serif font-medium text-[var(--color-botanical-primary)] leading-none">{activeCustomers}</div>
          </div>
          <div className="bg-[var(--color-surface-lowest)] p-4 rounded-xl border border-[var(--color-botanical-border)] shadow-xs">
            <div className="flex items-center justify-between text-[var(--color-botanical-subtle)] mb-1.5"><span className="text-[11px] uppercase tracking-wider font-semibold">Total Revenue</span><span className="material-symbols-outlined text-[16px] text-[var(--color-botanical-primary)]">payments</span></div>
            <div className="text-3xl font-serif font-medium text-[var(--color-botanical-primary)] leading-none">{formatINR(totalRevenue)}</div>
          </div>
          <div className="bg-[var(--color-surface-lowest)] p-4 rounded-xl border border-[var(--color-botanical-border)] shadow-xs">
            <div className="flex items-center justify-between text-[var(--color-botanical-subtle)] mb-1.5"><span className="text-[11px] uppercase tracking-wider font-semibold">Avg. Spend</span><span className="material-symbols-outlined text-[16px] text-[#964735]">trending_up</span></div>
            <div className="text-3xl font-serif font-medium text-[var(--color-botanical-primary)] leading-none">{formatINR(avgSpend)}</div>
          </div>
        </div>

        {/* Filters */}
        <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] p-3.5 shadow-xs">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative flex-1 min-w-[240px] max-w-md">
              <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-[16px] text-[var(--color-botanical-subtle)]">search</span>
              <input type="search" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Search customers by name, email, or ID..."
                className="w-full text-[13px] bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] focus:border-[#180f0a] rounded-lg pl-9 pr-3 py-1.5 text-[var(--color-botanical-text)] placeholder:text-[var(--color-botanical-subtle)] focus:ring-1 focus:ring-[#180f0a] transition" />
            </div>
            <div className="flex items-center gap-1.5">
              {['all', 'active', 'inactive'].map(s => (
                <button key={s} type="button" onClick={() => setStatusFilter(s)}
                  className={`px-3 py-1.5 rounded-full text-[12px] font-medium transition-all ${statusFilter === s ? 'bg-[#180f0a] text-white shadow-xs' : 'bg-[var(--color-surface-low)] text-[var(--color-botanical-muted)] hover:bg-[#ebe8e3]'}`}>
                  {s.charAt(0).toUpperCase() + s.slice(1)}
                </button>
              ))}
            </div>
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className="p-12 sm:p-16 bg-[var(--color-surface-lowest)] rounded-2xl text-center space-y-4 shadow-xs border border-[var(--color-botanical-border)]">
            <div className="w-16 h-16 rounded-full bg-[var(--color-surface-low)] mx-auto flex items-center justify-center text-[var(--color-botanical-subtle)]">
              <span className="material-symbols-outlined text-[32px]">group</span>
            </div>
            <div className="max-w-md mx-auto">
              <h3 className="font-serif text-2xl text-[var(--color-botanical-primary)] font-medium">No Customers Found</h3>
              <p className="text-[14px] text-[var(--color-botanical-muted)] mt-1.5">No customers match your current filter criteria.</p>
            </div>
            <button type="button" onClick={() => { setStatusFilter('all'); setSearchQuery(''); }} className="px-5 py-2 rounded-full bg-[#180f0a] text-white text-[13px] font-semibold shadow-xs hover:bg-[#2e241e] transition-colors">Clear Filters</button>
          </div>
        ) : (
          <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] shadow-xs overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-[13px]">
                <thead>
                  <tr className="bg-[var(--color-surface-low)] border-b border-[var(--color-botanical-border)] text-[var(--color-botanical-subtle)] font-semibold tracking-wide uppercase text-[11px]">
                    <th className="py-3 px-4 font-semibold">Customer</th>
                    <th className="py-3 px-4 font-semibold">Contact</th>
                    <th className="py-3 px-4 font-semibold">Location</th>
                    <th className="py-3 px-4 font-semibold">Orders</th>
                    <th className="py-3 px-4 font-semibold">Total Spend</th>
                    <th className="py-3 px-4 font-semibold">Status</th>
                    <th className="py-3 px-4 font-semibold">Since</th>
                    <th className="py-3 px-4 text-right font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#f0ede9] text-[var(--color-botanical-text)]">
                  {filtered.map(customer => (
                    <tr key={customer.id} className="hover:bg-[var(--color-surface-low)]/50 transition-colors">
                      <td className="py-3.5 px-4">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-full bg-[#180f0a] text-white flex items-center justify-center text-[11px] font-semibold shrink-0">
                            {customer.name.split(' ').map(w => w[0]).join('').slice(0, 2)}
                          </div>
                          <div>
                            <Link to={`/admin/customers/${customer.id}`} className="font-semibold text-[var(--color-botanical-primary)] hover:text-[#964735] transition-colors">{customer.name}</Link>
                            <p className="text-[11px] text-[var(--color-botanical-subtle)]">{customer.id}</p>
                          </div>
                        </div>
                      </td>
                      <td className="py-3.5 px-4">
                        <p className="text-[12px] text-[var(--color-botanical-muted)]">{customer.email}</p>
                        <p className="text-[11px] text-[var(--color-botanical-subtle)]">{customer.phone}</p>
                      </td>
                      <td className="py-3.5 px-4 text-[12px] text-[var(--color-botanical-muted)]">{customer.city}, {customer.state}</td>
                      <td className="py-3.5 px-4 font-semibold text-[var(--color-botanical-primary)]">{customer.orderCount}</td>
                      <td className="py-3.5 px-4 font-mono font-semibold text-[var(--color-botanical-primary)]">{formatINR(customer.totalSpend)}</td>
                      <td className="py-3.5 px-4">
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold ${customer.status === 'Active' ? 'bg-emerald-50 text-emerald-700' : 'bg-[var(--color-surface-low)] text-[var(--color-botanical-subtle)]'}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${customer.status === 'Active' ? 'bg-emerald-600' : 'bg-[#80756f]'}`}></span>
                          {customer.status}
                        </span>
                      </td>
                      <td className="py-3.5 px-4 text-[11px] text-[var(--color-botanical-subtle)]">{formatDate(customer.createdAt)}</td>
                      <td className="py-3.5 px-4 text-right">
                        <Link to={`/admin/customers/${customer.id}`} className="p-1 rounded hover:bg-[#ebe8e3] text-[var(--color-botanical-subtle)] hover:text-[var(--color-botanical-primary)] transition-colors inline-block" title="View Details">
                          <span className="material-symbols-outlined text-[18px]">visibility</span>
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="px-6 py-4 bg-[var(--color-surface-low)] border-t border-[var(--color-botanical-border)] flex items-center justify-between text-[12px] text-[var(--color-botanical-subtle)]">
              <span>Showing <strong className="text-[var(--color-botanical-primary)]">{filtered.length}</strong> of <strong className="text-[var(--color-botanical-primary)]">{totalCustomers}</strong> customers</span>
              <span>Live data</span>
            </div>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
