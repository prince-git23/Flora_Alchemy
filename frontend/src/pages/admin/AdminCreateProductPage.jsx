import React, { useState } from 'react';
import { useStoreVersion } from '../../hooks/useStoreVersion.js';
import { Link, useNavigate } from 'react-router-dom';
import AdminLayout from '../../components/admin/AdminLayout.jsx';
import ImageUploader from '../../components/admin/ImageUploader.jsx';
import { createProduct } from '../../services/productService.js';
import { formatINR } from '../../services/orderService.js';
import { ArrowLeft, Save, AlertCircle } from 'lucide-react';

export default function AdminCreateProductPage() {
  const navigate = useNavigate();
  const [formData, setFormData] = useState({
    name: '',
    shortName: '',
    description: '',
    shortDescription: '',
    price: '',
    originalPrice: '',
    category: 'bouquets',
    categoryLabel: 'Flowers & Bouquets',
    material: '',
    dimensions: '',
    craftTime: '',
    badge: '',
    availability: 'Ready to Ship',
    status: 'Active',
    initialStock: '20',
    reorderLevel: '10',
    stockTracked: true,
  });
  const [images, setImages] = useState(['']);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!formData.name.trim() || !formData.price) {
      setError('Product name and price are required.');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const productData = {
        ...formData,
        price: parseInt(formData.price, 10) || 0,
        originalPrice: formData.originalPrice ? parseInt(formData.originalPrice, 10) : null,
        initialStock: parseInt(formData.initialStock, 10) || 0,
        reorderLevel: parseInt(formData.reorderLevel, 10) || 10,
        stockTracked: formData.stockTracked,
        image: images.filter(Boolean)[0] || '',
        tags: [],
        palettes: [],
        ribbons: [],
        rating: 4.5,
        reviewCount: 0,
        isFeatured: false,
        isBestseller: false,
      };

      await createProduct(productData);
      navigate('/admin/products');
    } catch (err) {
      setError(err.message || 'Failed to create product.');
    }
    setLoading(false);
  };

  return (
    <AdminLayout>
      <div className="max-w-4xl mx-auto space-y-6 pb-12">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Link to="/admin/products" className="p-2 rounded-xl hover:bg-[#ebe8e3] text-[#4e4540] transition-colors">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div>
            <h1 className="font-serif text-2xl sm:text-3xl text-[#180f0a] tracking-tight font-normal">Add Product</h1>
            <p className="text-[13px] text-[#80756f] mt-0.5">New products are saved to the catalogue database</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          {error && (
            <div className="p-3 rounded-xl bg-[#ffdad3]/70 text-[#783020] text-[13px] flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              {error}
            </div>
          )}

          <div className="bg-white rounded-xl border border-[#e5e2dd] p-6 shadow-xs">
            <h2 className="font-serif text-lg text-[#180f0a] font-medium mb-4">Product Details</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="sm:col-span-2">
                <label className="block text-[12px] font-semibold text-[#4e4540] mb-1.5">Product Name *</label>
                <input type="text" value={formData.name} onChange={e => setFormData({ ...formData, name: e.target.value })}
                  placeholder="e.g., The Dusty Rose & Lavender Dream Posy"
                  className="w-full text-[13px] bg-[#f6f3ee] border border-[#d1c4bd] focus:border-[#180f0a] rounded-lg px-3 py-2 text-[#1c1c19] placeholder:text-[#80756f] focus:ring-1 focus:ring-[#180f0a] transition" />
              </div>
              <div className="sm:col-span-2">
                <label className="block text-[12px] font-semibold text-[#4e4540] mb-1.5">Short Name</label>
                <input type="text" value={formData.shortName} onChange={e => setFormData({ ...formData, shortName: e.target.value })}
                  placeholder="e.g., Dusty Rose Posy"
                  className="w-full text-[13px] bg-[#f6f3ee] border border-[#d1c4bd] focus:border-[#180f0a] rounded-lg px-3 py-2 text-[#1c1c19] placeholder:text-[#80756f] focus:ring-1 focus:ring-[#180f0a] transition" />
              </div>
              <div className="sm:col-span-2">
                <label className="block text-[12px] font-semibold text-[#4e4540] mb-1.5">Description</label>
                <textarea value={formData.description} onChange={e => setFormData({ ...formData, description: e.target.value })} rows={3}
                  placeholder="Full product description..."
                  className="w-full text-[13px] bg-[#f6f3ee] border border-[#d1c4bd] focus:border-[#180f0a] rounded-lg px-3 py-2 text-[#1c1c19] placeholder:text-[#80756f] focus:ring-1 focus:ring-[#180f0a] transition resize-none" />
              </div>
              <div className="sm:col-span-2">
                <label className="block text-[12px] font-semibold text-[#4e4540] mb-1.5">Short Description</label>
                <input type="text" value={formData.shortDescription} onChange={e => setFormData({ ...formData, shortDescription: e.target.value })}
                  placeholder="Brief summary for cards..."
                  className="w-full text-[13px] bg-[#f6f3ee] border border-[#d1c4bd] focus:border-[#180f0a] rounded-lg px-3 py-2 text-[#1c1c19] placeholder:text-[#80756f] focus:ring-1 focus:ring-[#180f0a] transition" />
              </div>
              <div>
                <label className="block text-[12px] font-semibold text-[#4e4540] mb-1.5">Category</label>
                <select value={formData.category} onChange={e => setFormData({ ...formData, category: e.target.value })}
                  className="w-full text-[13px] bg-[#f6f3ee] border border-[#d1c4bd] focus:border-[#180f0a] rounded-lg px-3 py-2 text-[#1c1c19] focus:ring-1 focus:ring-[#180f0a] transition">
                  <option value="bouquets">Bouquets</option>
                  <option value="cards">Cards</option>
                  <option value="charms">Charms & Vessels</option>
                  <option value="hampers">Hampers</option>
                  <option value="other">Other</option>
                </select>
              </div>
              <div>
                <label className="block text-[12px] font-semibold text-[#4e4540] mb-1.5">Category Label</label>
                <input type="text" value={formData.categoryLabel} onChange={e => setFormData({ ...formData, categoryLabel: e.target.value })}
                  placeholder="e.g., Flowers & Bouquets"
                  className="w-full text-[13px] bg-[#f6f3ee] border border-[#d1c4bd] focus:border-[#180f0a] rounded-lg px-3 py-2 text-[#1c1c19] placeholder:text-[#80756f] focus:ring-1 focus:ring-[#180f0a] transition" />
              </div>
              <div>
                <label className="block text-[12px] font-semibold text-[#4e4540] mb-1.5">Badge</label>
                <input type="text" value={formData.badge} onChange={e => setFormData({ ...formData, badge: e.target.value })}
                  placeholder="e.g., Bestseller, New Arrival"
                  className="w-full text-[13px] bg-[#f6f3ee] border border-[#d1c4bd] focus:border-[#180f0a] rounded-lg px-3 py-2 text-[#1c1c19] placeholder:text-[#80756f] focus:ring-1 focus:ring-[#180f0a] transition" />
              </div>
              <div>
                <label className="block text-[12px] font-semibold text-[#4e4540] mb-1.5">Availability</label>
                <select value={formData.availability} onChange={e => setFormData({ ...formData, availability: e.target.value })}
                  className="w-full text-[13px] bg-[#f6f3ee] border border-[#d1c4bd] focus:border-[#180f0a] rounded-lg px-3 py-2 text-[#1c1c19] focus:ring-1 focus:ring-[#180f0a] transition">
                  <option value="Ready to Ship">Ready to Ship</option>
                  <option value="Made to Order (3 days)">Made to Order (3 days)</option>
                  <option value="Pre-Order">Pre-Order</option>
                </select>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-xl border border-[#e5e2dd] p-6 shadow-xs">
            <h2 className="font-serif text-lg text-[#180f0a] font-medium mb-4">Pricing & Stock</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-[12px] font-semibold text-[#4e4540] mb-1.5">Price (₹) *</label>
                <input type="number" value={formData.price} onChange={e => setFormData({ ...formData, price: e.target.value })}
                  placeholder="e.g., 1850"
                  className="w-full text-[13px] bg-[#f6f3ee] border border-[#d1c4bd] focus:border-[#180f0a] rounded-lg px-3 py-2 text-[#1c1c19] placeholder:text-[#80756f] focus:ring-1 focus:ring-[#180f0a] transition" />
              </div>
              <div>
                <label className="block text-[12px] font-semibold text-[#4e4540] mb-1.5">Original Price (₹)</label>
                <input type="number" value={formData.originalPrice} onChange={e => setFormData({ ...formData, originalPrice: e.target.value })}
                  placeholder="e.g., 2200"
                  className="w-full text-[13px] bg-[#f6f3ee] border border-[#d1c4bd] focus:border-[#180f0a] rounded-lg px-3 py-2 text-[#1c1c19] placeholder:text-[#80756f] focus:ring-1 focus:ring-[#180f0a] transition" />
              </div>
              <div>
                <label className="block text-[12px] font-semibold text-[#4e4540] mb-1.5">Initial Stock</label>
                <input type="number" value={formData.initialStock} min="0"
                  onChange={e => setFormData({ ...formData, initialStock: e.target.value })}
                  className="w-full text-[13px] bg-[#f6f3ee] border border-[#d1c4bd] focus:border-[#180f0a] rounded-lg px-3 py-2 text-[#1c1c19] focus:ring-1 focus:ring-[#180f0a] transition" />
              </div>
              <div>
                <label className="block text-[12px] font-semibold text-[#4e4540] mb-1.5">Reorder Level</label>
                <input type="number" value={formData.reorderLevel} min="0"
                  onChange={e => setFormData({ ...formData, reorderLevel: e.target.value })}
                  className="w-full text-[13px] bg-[#f6f3ee] border border-[#d1c4bd] focus:border-[#180f0a] rounded-lg px-3 py-2 text-[#1c1c19] focus:ring-1 focus:ring-[#180f0a] transition" />
              </div>
              <div className="sm:col-span-2">
                <label className="flex items-center gap-3 cursor-pointer">
                  <input type="checkbox" checked={formData.stockTracked}
                    onChange={e => setFormData({ ...formData, stockTracked: e.target.checked })}
                    className="w-4 h-4 rounded border-[#d1c4bd] text-[#180f0a] focus:ring-[#180f0a]" />
                  <span className="text-[12px] font-semibold text-[#4e4540]">Track inventory for this product</span>
                </label>
                <p className="text-[11px] text-[#80756f] mt-1 ml-7">Enable to manage stock levels and receive low-stock alerts.</p>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-xl border border-[#e5e2dd] p-6 shadow-xs">
            <h2 className="font-serif text-lg text-[#180f0a] font-medium mb-4">Materials & Crafting</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="sm:col-span-2">
                <label className="block text-[12px] font-semibold text-[#4e4540] mb-1.5">Materials</label>
                <input type="text" value={formData.material} onChange={e => setFormData({ ...formData, material: e.target.value })}
                  placeholder="e.g., Cotton chenille stems, mulberry bark paper, silk ribbon"
                  className="w-full text-[13px] bg-[#f6f3ee] border border-[#d1c4bd] focus:border-[#180f0a] rounded-lg px-3 py-2 text-[#1c1c19] placeholder:text-[#80756f] focus:ring-1 focus:ring-[#180f0a] transition" />
              </div>
              <div className="sm:col-span-2">
                <label className="block text-[12px] font-semibold text-[#4e4540] mb-1.5">Dimensions</label>
                <input type="text" value={formData.dimensions} onChange={e => setFormData({ ...formData, dimensions: e.target.value })}
                  placeholder="e.g., Height: ~28 cm · Weight: ~165g"
                  className="w-full text-[13px] bg-[#f6f3ee] border border-[#d1c4bd] focus:border-[#180f0a] rounded-lg px-3 py-2 text-[#1c1c19] placeholder:text-[#80756f] focus:ring-1 focus:ring-[#180f0a] transition" />
              </div>
              <div>
                <label className="block text-[12px] font-semibold text-[#4e4540] mb-1.5">Craft Time</label>
                <input type="text" value={formData.craftTime} onChange={e => setFormData({ ...formData, craftTime: e.target.value })}
                  placeholder="e.g., 4.5 Hours · 14 Stems"
                  className="w-full text-[13px] bg-[#f6f3ee] border border-[#d1c4bd] focus:border-[#180f0a] rounded-lg px-3 py-2 text-[#1c1c19] placeholder:text-[#80756f] focus:ring-1 focus:ring-[#180f0a] transition" />
              </div>
            </div>
          </div>

          <div className="bg-white rounded-xl border border-[#e5e2dd] p-6 shadow-xs">
            <h2 className="font-serif text-lg text-[#180f0a] font-medium mb-1">Product Images</h2>
            <p className="text-[12px] text-[#80756f] mb-3">The first image is used as the primary storefront photo. Images upload to hosted storage when configured, otherwise to the site's own media storage.</p>
            <ImageUploader images={images} onChange={setImages} />
          </div>

          <div className="flex items-center justify-end gap-3 pt-4">
            <Link to="/admin/products" className="px-5 py-2.5 rounded-full bg-white text-[#4e4540] hover:bg-[#f6f3ee] border border-[#d1c4bd] text-[13px] font-semibold transition">
              Cancel
            </Link>
            <button type="submit" disabled={loading}
              className="px-6 py-2.5 rounded-full bg-[#180f0a] hover:bg-[#2e241e] disabled:opacity-50 text-white text-[13px] font-semibold transition shadow-sm flex items-center gap-2">
              {loading ? (
                <>
                  <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>
                  Saving...
                </>
              ) : (
                <>
                  <Save className="w-4 h-4" />
                  Save Product
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </AdminLayout>
  );
}
