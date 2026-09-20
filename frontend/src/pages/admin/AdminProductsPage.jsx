import React, { useState, useMemo } from 'react';
import { useStoreVersion } from '../../hooks/useStoreVersion.js';
import { Link } from 'react-router-dom';
import AdminLayout from '../../components/admin/AdminLayout.jsx';
import { getProducts } from '../../services/productService.js';
import { getInventory } from '../../services/inventoryService.js';
import { formatINR, formatDate } from '../../services/orderService.js';

export default function AdminProductsPage() {
  const storeVersion = useStoreVersion();
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');

  const products = useMemo(() => getProducts(), [storeVersion]);
  const inventory = useMemo(() => getInventory(), [storeVersion]);

  const categories = useMemo(() => {
    const cats = [...new Set(products.map(p => p.category))];
    return [{ id: 'all', label: 'All Products' }, ...cats.map(c => ({ id: c, label: c.charAt(0).toUpperCase() + c.slice(1) }))];
  }, [products]);

  const productsWithInventory = useMemo(() => {
    return products.map(p => {
      const inv = inventory.find(i => i.productId === p.id);
      return { ...p, stock: inv?.currentStock || 0, stockStatus: inv?.status || 'Unknown', sku: inv?.sku || 'N/A' };
    });
  }, [products, inventory]);

  const filtered = useMemo(() => {
    let list = [...productsWithInventory];
    if (categoryFilter !== 'all') list = list.filter(p => p.category === categoryFilter);
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(p => p.name.toLowerCase().includes(q) || p.shortName?.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q));
    }
    return list;
  }, [productsWithInventory, categoryFilter, searchQuery]);

  return (
    <AdminLayout>
      <div className="max-w-7xl mx-auto space-y-6 pb-12">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="font-serif text-3xl sm:text-4xl text-[#180f0a] tracking-tight font-normal">Products</h1>
            <p className="text-[14px] text-[#4e4540] mt-1">Manage the botanical product catalog, pricing, and visibility</p>
          </div>
          <div className="flex items-center gap-2.5">
            <Link to="/admin/products/new" className="inline-flex items-center gap-2 px-4 py-2 text-[12px] font-semibold text-white bg-[#180f0a] hover:bg-[#2e241e] rounded-full transition shadow-sm">
              <span className="material-symbols-outlined text-[16px]">add</span>
              + Add Product
            </Link>
          </div>
        </div>

        {/* KPI Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3.5">
          <div className="bg-white p-4 rounded-xl border border-[#e5e2dd] shadow-xs">
            <div className="flex items-center justify-between text-[#80756f] mb-1.5">
              <span className="text-[11px] uppercase tracking-wider font-semibold">Total Products</span>
              <span className="material-symbols-outlined text-[16px]">inventory_2</span>
            </div>
            <div className="text-3xl font-serif font-medium text-[#180f0a] leading-none">{products.length}</div>
          </div>
          <div className="bg-white p-4 rounded-xl border border-[#e5e2dd] shadow-xs">
            <div className="flex items-center justify-between text-[#80756f] mb-1.5">
              <span className="text-[11px] uppercase tracking-wider font-semibold">In Stock</span>
              <span className="material-symbols-outlined text-[16px] text-[#5b6d54]">check_circle</span>
            </div>
            <div className="text-3xl font-serif font-medium text-[#180f0a] leading-none">{inventory.filter(i => i.status === 'In Stock').length}</div>
          </div>
          <div className="bg-white p-4 rounded-xl border border-[#e5e2dd] shadow-xs">
            <div className="flex items-center justify-between text-[#80756f] mb-1.5">
              <span className="text-[11px] uppercase tracking-wider font-semibold">Low Stock</span>
              <span className="material-symbols-outlined text-[16px] text-[#964735]">warning</span>
            </div>
            <div className="text-3xl font-serif font-medium text-[#964735] leading-none">{inventory.filter(i => i.status === 'Low Stock' || i.status === 'Critical').length}</div>
          </div>
          <div className="bg-white p-4 rounded-xl border border-[#e5e2dd] shadow-xs">
            <div className="flex items-center justify-between text-[#80756f] mb-1.5">
              <span className="text-[11px] uppercase tracking-wider font-semibold">Categories</span>
              <span className="material-symbols-outlined text-[16px]">category</span>
            </div>
            <div className="text-3xl font-serif font-medium text-[#180f0a] leading-none">{categories.length - 1}</div>
          </div>
        </div>

        {/* Filters */}
        <div className="bg-white rounded-xl border border-[#e5e2dd] p-3.5 shadow-xs">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative flex-1 min-w-[240px] max-w-md">
              <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-[16px] text-[#80756f]">search</span>
              <input type="search" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Search products, SKU..."
                className="w-full text-[13px] bg-[#f6f3ee] border border-[#d1c4bd] focus:border-[#180f0a] rounded-lg pl-9 pr-3 py-1.5 text-[#1c1c19] placeholder:text-[#80756f] focus:ring-1 focus:ring-[#180f0a] transition" />
            </div>
            <div className="flex items-center gap-1.5 overflow-x-auto">
              {categories.map(cat => (
                <button key={cat.id} type="button" onClick={() => setCategoryFilter(cat.id)}
                  className={`px-3 py-1.5 rounded-full text-[12px] font-medium shrink-0 transition-all ${categoryFilter === cat.id ? 'bg-[#180f0a] text-white shadow-xs' : 'bg-[#f6f3ee] text-[#4e4540] hover:bg-[#ebe8e3]'}`}>
                  {cat.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Empty State (real — driven by current filters) */}
        {filtered.length === 0 && (
          <div className="p-12 sm:p-16 bg-white rounded-2xl text-center space-y-4 shadow-xs border border-[#e5e2dd]">
            <div className="w-16 h-16 rounded-full bg-[#f6f3ee] mx-auto flex items-center justify-center text-[#80756f]">
              <span className="material-symbols-outlined text-[32px]">inventory_2</span>
            </div>
            <div className="max-w-md mx-auto">
              <h3 className="font-serif text-2xl text-[#180f0a] font-medium">No Products Found</h3>
              <p className="text-[14px] text-[#4e4540] mt-1.5">No products match your current search or filter criteria.</p>
            </div>
            <button type="button" onClick={() => { setCategoryFilter('all'); setSearchQuery(''); }} className="px-5 py-2 rounded-full bg-[#180f0a] text-white text-[13px] font-semibold shadow-xs hover:bg-[#2e241e] transition-colors">Clear Filters</button>
          </div>
        )}

        {/* Product Grid */}
        {filtered.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {filtered.map(product => (
              <Link key={product.id} to={`/admin/products/${product.id}`}
                className="bg-white rounded-xl border border-[#e5e2dd] shadow-xs hover:shadow-md hover:border-[#d1c4bd] transition-all overflow-hidden group">
                <div className="aspect-[4/3] bg-[#f6f3ee] overflow-hidden">
                  <img src={product.images?.[0] || ''} alt={product.name} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" loading="lazy" />
                </div>
                <div className="p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] uppercase font-bold tracking-wider text-[#80756f]">{product.categoryLabel || product.category}</span>
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${product.stockStatus === 'In Stock' ? 'bg-emerald-50 text-emerald-700' : product.stockStatus === 'Critical' ? 'bg-red-50 text-red-700' : 'bg-[#ffdad3] text-[#783020]'}`}>
                      {product.stockStatus} · {product.stock}
                    </span>
                  </div>
                  <h3 className="font-serif text-[15px] text-[#180f0a] font-medium leading-snug line-clamp-2">{product.name}</h3>
                  <div className="flex items-center justify-between pt-2 border-t border-[#f0ede9]">
                    <div>
                      <span className="text-[16px] font-bold text-[#180f0a]">{formatINR(product.price)}</span>
                      {product.originalPrice && <span className="text-[11px] text-[#80756f] line-through ml-1.5">{formatINR(product.originalPrice)}</span>}
                    </div>
                    <span className="text-[10px] text-[#80756f] font-mono">{product.sku}</span>
                  </div>
                  <div className="flex items-center gap-2 pt-1">
                    <span className={`w-1.5 h-1.5 rounded-full ${product.visibility === 'Hidden' ? 'bg-[#ba1a1a]' : 'bg-[#5b6d54]'}`}></span>
                    <span className="text-[11px] text-[#80756f]">{product.visibility === 'Hidden' ? 'Hidden' : 'Visible'}</span>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}

        {/* Footer */}
        <div className="text-center text-[12px] text-[#80756f] pt-4">
          All prices in INR (₹)
        </div>
      </div>
    </AdminLayout>
  );
}
