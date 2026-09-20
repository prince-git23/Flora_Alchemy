import React, { useState, useMemo, useEffect, useRef } from 'react';
import { useStoreVersion } from '../../hooks/useStoreVersion.js';
import { Link } from 'react-router-dom';
import AdminLayout from '../../components/admin/AdminLayout.jsx';
import { getOrders, ORDER_STATUSES, ORDER_STATUS_STYLES, getStatusCounts, formatINR, formatDate } from '../../services/orderService.js';
import { AdminOrderStatusPill, AdminPaymentStatusPill } from '../../components/admin/AdminStatusPill.jsx';

/* ── GSAP ── */
import gsap from 'gsap';

const prefersReduced = typeof window !== 'undefined' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export default function AdminOrdersPage() {
  const storeVersion = useStoreVersion();
  const [statusFilter, setStatusFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [dateFilter, setDateFilter] = useState('all');
  const [paymentFilter, setPaymentFilter] = useState('all');
  const [selectedOrders, setSelectedOrders] = useState([]);
  const pageRef = useRef(null);

  /* ── GSAP: operational reveal — one entrance, no per-row animation ── */
  useEffect(() => {
    if (prefersReduced || !pageRef.current) return;
    const ctx = gsap.context(() => {
      gsap.from('[data-orders-kpi]', { y: 14, opacity: 0, duration: 0.4, ease: 'power2.out', stagger: 0.05, delay: 0.05 });
      gsap.from('[data-orders-toolbar]', { y: 16, opacity: 0, duration: 0.45, ease: 'power2.out', delay: 0.15 });
    }, pageRef);
    return () => ctx.revert();
  }, []);

  const orders = useMemo(() => getOrders(), [storeVersion]);
  const counts = getStatusCounts();

  const statusTabs = [
    { key: 'all', label: 'All Orders', count: counts.total },
    { key: 'new', label: 'New', count: counts.new },
    { key: 'confirmed', label: 'Confirmed', count: counts.confirmed },
    { key: 'in_production', label: 'In Production', count: counts.inProduction },
    { key: 'quality_check', label: 'Quality Check', count: counts.qualityCheck },
    { key: 'ready_to_dispatch', label: 'Ready to Dispatch', count: counts.readyToDispatch },
    { key: 'shipped', label: 'Shipped', count: counts.shipped },
    { key: 'delivered', label: 'Delivered', count: counts.delivered },
  ];

  const filteredOrders = useMemo(() => {
    let list = [...orders];
    if (statusFilter !== 'all') list = list.filter(o => o.orderStatus === statusFilter);
    if (paymentFilter !== 'all') list = list.filter(o => o.paymentStatus === paymentFilter);
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(o =>
        o.id.toLowerCase().includes(q) ||
        o.customerName.toLowerCase().includes(q) ||
        o.customerEmail.toLowerCase().includes(q)
      );
    }
    return list;
  }, [orders, statusFilter, paymentFilter, searchQuery]);

  const toggleSelectAll = () => {
    if (selectedOrders.length === filteredOrders.length) {
      setSelectedOrders([]);
    } else {
      setSelectedOrders(filteredOrders.map(o => o.id));
    }
  };

  const toggleSelect = (orderId) => {
    setSelectedOrders(prev =>
      prev.includes(orderId) ? prev.filter(id => id !== orderId) : [...prev, orderId]
    );
  };

  const handleExportCSV = () => {
    const rows = [['Order ID', 'Customer', 'Email', 'Items', 'Total', 'Payment', 'Status', 'Created']];
    filteredOrders.forEach(o => {
      rows.push([o.id, o.customerName, o.customerEmail, o.items.length, o.total, o.paymentStatus, o.orderStatus, formatDate(o.createdAt)]);
    });
    const csv = rows.map(r => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'flora_alchemy_orders.csv';
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <AdminLayout>
      <div ref={pageRef} className="max-w-7xl mx-auto space-y-6 pb-12">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="font-serif text-3xl sm:text-4xl text-[#180f0a] tracking-tight font-normal">Orders</h1>
            <p className="text-[14px] text-[#4e4540] mt-1">
              Manage customer orders, production progress, payments, and fulfillment
            </p>
          </div>
          <div className="flex items-center gap-2.5 shrink-0">
            <button type="button" onClick={handleExportCSV} className="inline-flex items-center gap-2 px-3.5 py-2 text-[12px] font-medium text-[#1c1c19] bg-white hover:bg-[#f6f3ee] border border-[#d1c4bd] rounded-full transition shadow-xs">
              <span className="material-symbols-outlined text-[16px]">download</span>
              Export CSV
            </button>
            <Link to="/admin/orders/new" className="inline-flex items-center gap-2 px-4 py-2 text-[12px] font-semibold text-white bg-[#180f0a] hover:bg-[#2e241e] rounded-full transition shadow-sm">
              <span className="material-symbols-outlined text-[16px]">add</span>
              + Create Order
            </Link>
          </div>
        </div>

        {/* KPI Strip */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3.5">
          <div data-orders-kpi className="bg-white p-4 rounded-xl border border-[#e5e2dd] shadow-xs hover:border-[#d1c4bd] hover:shadow-md hover:-translate-y-0.5 transition-all duration-300">
            <div className="flex items-center justify-between text-[#80756f] mb-1.5">
              <span className="text-[11px] uppercase tracking-wider font-semibold">Total Orders</span>
              <span className="material-symbols-outlined text-[16px]">shopping_bag</span>
            </div>
            <div className="text-3xl font-serif font-medium text-[#180f0a] leading-none">{counts.total}</div>
            <p className="text-[11px] text-[#80756f] mt-2">All customer orders</p>
          </div>
          <div data-orders-kpi className="bg-white p-4 rounded-xl border border-[#e5e2dd] shadow-xs hover:border-[#d1c4bd] hover:shadow-md hover:-translate-y-0.5 transition-all duration-300">
            <div className="flex items-center justify-between text-[#80756f] mb-1.5">
              <span className="text-[11px] uppercase tracking-wider font-semibold">New Orders</span>
              <span className="material-symbols-outlined text-[16px] text-[#964735]">schedule</span>
            </div>
            <div className="text-3xl font-serif font-medium text-[#180f0a] leading-none">{counts.new}</div>
            <p className="text-[11px] text-[#964735] mt-2 font-medium flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-[#964735] animate-pulse"></span>
              Requires attention
            </p>
          </div>
          <div data-orders-kpi className="bg-white p-4 rounded-xl border border-[#e5e2dd] shadow-xs hover:border-[#d1c4bd] hover:shadow-md hover:-translate-y-0.5 transition-all duration-300">
            <div className="flex items-center justify-between text-[#80756f] mb-1.5">
              <span className="text-[11px] uppercase tracking-wider font-semibold">In Production</span>
              <span className="material-symbols-outlined text-[16px] text-[#180f0a]">precision_manufacturing</span>
            </div>
            <div className="text-3xl font-serif font-medium text-[#180f0a] leading-none">{counts.inProduction}</div>
            <p className="text-[11px] text-[#4e4540] mt-2 flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-[#2e241e]"></span>
              Currently being crafted
            </p>
          </div>
          <div data-orders-kpi className="bg-white p-4 rounded-xl border border-[#e5e2dd] shadow-xs hover:border-[#d1c4bd] hover:shadow-md hover:-translate-y-0.5 transition-all duration-300">
            <div className="flex items-center justify-between text-[#80756f] mb-1.5">
              <span className="text-[11px] uppercase tracking-wider font-semibold">Ready to Dispatch</span>
              <span className="material-symbols-outlined text-[16px] text-[#5b6d54]">inventory_2</span>
            </div>
            <div className="text-3xl font-serif font-medium text-[#180f0a] leading-none">{counts.readyToDispatch}</div>
            <p className="text-[11px] text-[#5b6d54] mt-2 font-medium flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-[#5b6d54]"></span>
              Awaiting dispatch
            </p>
          </div>
          <div data-orders-kpi className="bg-white p-4 rounded-xl border border-[#e5e2dd] shadow-xs hover:border-[#d1c4bd] hover:shadow-md hover:-translate-y-0.5 transition-all duration-300">
            <div className="flex items-center justify-between text-[#80756f] mb-1.5">
              <span className="text-[11px] uppercase tracking-wider font-semibold">Delivered</span>
              <span className="material-symbols-outlined text-[16px]">check_circle</span>
            </div>
            <div className="text-3xl font-serif font-medium text-[#180f0a] leading-none">{counts.delivered}</div>
            <p className="text-[11px] text-[#80756f] mt-2">Archived fulfilled</p>
          </div>
        </div>

        {/* Filter Toolbar */}
        <div data-orders-toolbar className="bg-white rounded-xl border border-[#e5e2dd] p-3.5 shadow-xs space-y-3">
          {/* Status Tabs */}
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1 border-b border-[#f0ede9] -mx-1 px-1 scrollbar-none">
            {statusTabs.map(tab => (
              <button key={tab.key} type="button" onClick={() => setStatusFilter(tab.key)}
                className={`px-3 py-1.5 rounded-full text-[12px] font-medium shrink-0 transition-all ${statusFilter === tab.key ? 'bg-[#180f0a] text-white shadow-xs' : 'bg-[#f6f3ee] text-[#4e4540] hover:bg-[#ebe8e3]'}`}>
                {tab.label} <span className={`ml-1 ${statusFilter === tab.key ? 'text-white/80' : 'text-[#80756f]'}`}>{tab.count}</span>
              </button>
            ))}
          </div>
          {/* Detailed Filters */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="relative flex-1 min-w-[240px] max-w-md">
              <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-[16px] text-[#80756f]">search</span>
              <input type="search" value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
                placeholder="Search by order ID, customer name, email..."
                className="w-full text-[13px] bg-[#f6f3ee] border border-[#d1c4bd] focus:border-[#180f0a] rounded-lg pl-9 pr-3 py-1.5 text-[#1c1c19] placeholder:text-[#80756f] focus:ring-1 focus:ring-[#180f0a] transition" />
            </div>
            <div className="flex items-center flex-wrap gap-2 text-[12px]">                <div className="flex items-center gap-1.5 bg-[#f6f3ee] border border-[#d1c4bd] px-2.5 py-1.5 rounded-lg text-[#1c1c19]">
                  <span className="text-[#80756f]">Payment:</span>
                  <select value={paymentFilter} onChange={e => setPaymentFilter(e.target.value)} className="bg-transparent border-0 p-0 text-[12px] font-semibold text-[#180f0a] focus:ring-0 cursor-pointer">
                    <option value="all">All</option>
                    <option value="Paid">Paid</option>
                    <option value="Pending">Pending</option>
                    <option value="Failed">Failed</option>
                    <option value="Refunded">Refunded</option>
                  </select>
                </div>
              <button type="button" onClick={() => { setStatusFilter('all'); setPaymentFilter('all'); setSearchQuery(''); }} className="text-[12px] text-[#80756f] hover:text-[#180f0a] px-2 py-1 underline underline-offset-2 transition-colors">Reset</button>
            </div>
          </div>
        </div>

        {/* Empty State (real — driven by current filters) */}
        {filteredOrders.length === 0 && (
          <div className="p-12 sm:p-16 bg-white rounded-2xl text-center space-y-4 shadow-xs border border-[#e5e2dd]">
            <div className="w-16 h-16 rounded-full bg-[#f6f3ee] mx-auto flex items-center justify-center text-[#80756f]">
              <span className="material-symbols-outlined text-[32px]">shopping_bag</span>
            </div>
            <div className="max-w-md mx-auto">
              <h3 className="font-serif text-2xl text-[#180f0a] font-medium">No Orders Found</h3>
              <p className="text-[14px] text-[#4e4540] mt-1.5">No orders match your current filter criteria. Try adjusting your search or clearing filters.</p>
            </div>
            <button type="button" onClick={() => { setStatusFilter('all'); setPaymentFilter('all'); setSearchQuery(''); }} className="px-5 py-2 rounded-full bg-[#180f0a] text-white text-[13px] font-semibold shadow-xs hover:bg-[#2e241e] transition-colors">Clear Filters</button>
          </div>
        )}

        {/* Orders Table */}
        {filteredOrders.length > 0 && (
          <div className="bg-white rounded-xl border border-[#e5e2dd] shadow-xs overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-[13px]">
                <thead>
                  <tr className="bg-[#f6f3ee] border-b border-[#e5e2dd] text-[#80756f] font-semibold tracking-wide uppercase text-[11px]">
                    <th className="py-3 px-4 w-10 text-center">
                      <input type="checkbox" checked={selectedOrders.length === filteredOrders.length && filteredOrders.length > 0} onChange={toggleSelectAll}
                        className="rounded border-[#d1c4bd] text-[#180f0a] focus:ring-[#180f0a] h-3.5 w-3.5 cursor-pointer" />
                    </th>
                    <th className="py-3 px-4 font-semibold">Order</th>
                    <th className="py-3 px-4 font-semibold">Customer</th>
                    <th className="py-3 px-4 font-semibold">Items</th>
                    <th className="py-3 px-4 font-semibold">Total</th>
                    <th className="py-3 px-4 font-semibold">Payment</th>
                    <th className="py-3 px-4 font-semibold">Status</th>
                    <th className="py-3 px-4 font-semibold">Created</th>
                    <th className="py-3 px-4 text-right font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#f0ede9] text-[#1c1c19]">
                  {filteredOrders.map(order => {
                    const style = ORDER_STATUS_STYLES[order.orderStatus] || ORDER_STATUS_STYLES.new;
                    const statusObj = ORDER_STATUSES.find(s => s.key === order.orderStatus);
                    return (
                      <tr key={order.id} className="hover:bg-[#f6f3ee]/50 transition-colors">
                        <td className="py-3.5 px-4 text-center">
                          <input type="checkbox" checked={selectedOrders.includes(order.id)} onChange={() => toggleSelect(order.id)}
                            className="rounded border-[#d1c4bd] text-[#180f0a] focus:ring-[#180f0a] h-3.5 w-3.5 cursor-pointer" />
                        </td>
                        <td className="py-3.5 px-4 whitespace-nowrap">
                          <div className="flex items-center gap-1.5">
                            <Link to={`/admin/orders/${order.id}`} className="font-mono font-semibold text-[#180f0a] hover:text-[#964735] transition-colors">#{order.id}</Link>
                            {order.isRush && <span className="inline-flex items-center px-1.5 py-0.2 text-[10px] font-bold uppercase rounded bg-[#ffdad3] text-[#783020] border border-[#edd1cc]">Rush</span>}
                          </div>
                        </td>
                        <td className="py-3.5 px-4">
                          <div className="font-semibold text-[#180f0a]">{order.customerName}</div>
                          <div className="text-[11px] text-[#80756f] truncate max-w-[150px]">{order.customerEmail}</div>
                        </td>
                        <td className="py-3.5 px-4">
                          <div className="font-medium">{order.items.length} item{order.items.length > 1 ? 's' : ''}</div>
                          <div className="text-[11px] text-[#80756f] truncate max-w-[190px]">{order.items.map(i => i.name).join(', ')}</div>
                        </td>
                        <td className="py-3.5 px-4 whitespace-nowrap font-mono font-semibold text-[#180f0a]">{formatINR(order.total)}</td>
                        <td className="py-3.5 px-4 whitespace-nowrap">
                          <AdminPaymentStatusPill status={order.paymentStatus} />
                        </td>
                        <td className="py-3.5 px-4 whitespace-nowrap">
                          <AdminOrderStatusPill status={order.orderStatus} />
                        </td>
                        <td className="py-3.5 px-4 whitespace-nowrap text-[11px] text-[#80756f]">{formatDate(order.createdAt)}</td>
                        <td className="py-3.5 px-4 whitespace-nowrap text-right">
                          <Link to={`/admin/orders/${order.id}`} className="p-1 rounded hover:bg-[#ebe8e3] text-[#80756f] hover:text-[#180f0a] transition-colors inline-block" title="View Details">
                            <span className="material-symbols-outlined text-[18px]">visibility</span>
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {/* Pagination */}
            <div className="px-6 py-4 bg-[#f6f3ee] border-t border-[#e5e2dd] flex items-center justify-between text-[12px] text-[#80756f]">
              <span>Showing <strong className="text-[#180f0a]">{filteredOrders.length}</strong> of <strong className="text-[#180f0a]">{orders.length}</strong> orders</span>
              <span>Live records</span>
            </div>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
