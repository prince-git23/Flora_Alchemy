import React, { useState } from 'react';
import { useStoreVersion } from '../../hooks/useStoreVersion.js';
import { Link, useNavigate } from 'react-router-dom';
import AdminLayout from '../../components/admin/AdminLayout.jsx';
import ImageUploader from '../../components/admin/ImageUploader.jsx';
import ReferenceImageStudio from '../../components/admin/ReferenceImageStudio.jsx';
import { createProduct } from '../../services/productService.js';
import { formatINR } from '../../services/orderService.js';
import { ArrowLeft, Save, AlertCircle, AlertTriangle } from 'lucide-react';

/**
 * A draft key groups the 3D Studio reference images that are uploaded BEFORE
 * the product exists (the studio is used inside this form). It is generated
 * here, stored on the reference rows server-side, and sent with the create so
 * the server can attach the accepted set and drop the rest. A page reload
 * starts a fresh key: the earlier draft set was never accepted and is cleaned
 * up by the server's age-bounded sweep.
 */
function makeDraftKey() {
  try {
    return `draft-${crypto.randomUUID()}`;
  } catch {
    return `draft-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

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
  // 3D Studio — Phase 1 state.
  const [referenceDraftKey] = useState(makeDraftKey);
  const [referenceIds, setReferenceIds] = useState([]);
  const [referenceWarning, setReferenceWarning] = useState('');
  // True while the studio is uploading or processing. Saving is held back until
  // it settles: a create discards the reference images that were not accepted,
  // and deleting a row mid-processing would throw away work in flight.
  const [studioBusy, setStudioBusy] = useState(false);

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
        // Preserve EVERY uploaded photo — the backend stores the gallery and
        // derives the singular `image` from its first entry.
        images: images.filter(Boolean),
        tags: [],
        palettes: [],
        ribbons: [],
        rating: 4.5,
        reviewCount: 0,
        isFeatured: false,
        isBestseller: false,
        // Prepared reference images the administrator accepted in the studio.
        // The server attaches them in this same write and discards the ones
        // that were not accepted.
        referenceImageIds: referenceIds,
        referenceDraftKey,
      };

      const created = await createProduct(productData);
      if (created?.referenceHandoff?.error) {
        // The product WAS saved. Saying otherwise would be a lie, and hiding the
        // problem would leave the administrator with silent image loss — so the
        // product is kept and the image problem is reported on the next screen.
        setReferenceWarning(
          `${created.referenceHandoff.attached} of ${referenceIds.length} prepared images were attached: ${created.referenceHandoff.error}`
        );
        setLoading(false);
        return;
      }
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
          <Link to="/admin/products" className="p-2 rounded-xl hover:bg-[var(--color-surface-high)] text-[var(--color-botanical-muted)] transition-colors">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div>
            <h1 className="font-serif text-2xl sm:text-3xl text-[var(--color-botanical-primary)] tracking-tight font-normal">Add Product</h1>
            <p className="text-[13px] text-[var(--color-botanical-subtle)] mt-0.5">New products are saved to the catalogue database</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          {error && (
            <div className="p-3 rounded-xl bg-[var(--color-badge-bg)]/70 text-[var(--color-badge-fg-strong)] text-[13px] flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              {error}
            </div>
          )}

          {referenceWarning && (
            <div className="p-3 rounded-xl bg-amber-50 text-amber-900 text-[13px] flex items-start gap-2" role="alert">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              {referenceWarning}
            </div>
          )}

          <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] p-6 shadow-xs">
            <h2 className="font-serif text-lg text-[var(--color-botanical-primary)] font-medium mb-4">Product Details</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="sm:col-span-2">
                <label className="block text-[12px] font-semibold text-[var(--color-botanical-muted)] mb-1.5">Product Name *</label>
                <input type="text" value={formData.name} onChange={e => setFormData({ ...formData, name: e.target.value })}
                  placeholder="e.g., The Dusty Rose & Lavender Dream Posy"
                  className="w-full text-[13px] bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] focus:border-[var(--color-focus)] rounded-lg px-3 py-2 text-[var(--color-botanical-text)] placeholder:text-[var(--color-botanical-subtle)] focus:ring-1 focus:ring-[var(--color-focus)] transition" />
              </div>
              <div className="sm:col-span-2">
                <label className="block text-[12px] font-semibold text-[var(--color-botanical-muted)] mb-1.5">Short Name</label>
                <input type="text" value={formData.shortName} onChange={e => setFormData({ ...formData, shortName: e.target.value })}
                  placeholder="e.g., Dusty Rose Posy"
                  className="w-full text-[13px] bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] focus:border-[var(--color-focus)] rounded-lg px-3 py-2 text-[var(--color-botanical-text)] placeholder:text-[var(--color-botanical-subtle)] focus:ring-1 focus:ring-[var(--color-focus)] transition" />
              </div>
              <div className="sm:col-span-2">
                <label className="block text-[12px] font-semibold text-[var(--color-botanical-muted)] mb-1.5">Description</label>
                <textarea value={formData.description} onChange={e => setFormData({ ...formData, description: e.target.value })} rows={3}
                  placeholder="Full product description..."
                  className="w-full text-[13px] bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] focus:border-[var(--color-focus)] rounded-lg px-3 py-2 text-[var(--color-botanical-text)] placeholder:text-[var(--color-botanical-subtle)] focus:ring-1 focus:ring-[var(--color-focus)] transition resize-none" />
              </div>
              <div className="sm:col-span-2">
                <label className="block text-[12px] font-semibold text-[var(--color-botanical-muted)] mb-1.5">Short Description</label>
                <input type="text" value={formData.shortDescription} onChange={e => setFormData({ ...formData, shortDescription: e.target.value })}
                  placeholder="Brief summary for cards..."
                  className="w-full text-[13px] bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] focus:border-[var(--color-focus)] rounded-lg px-3 py-2 text-[var(--color-botanical-text)] placeholder:text-[var(--color-botanical-subtle)] focus:ring-1 focus:ring-[var(--color-focus)] transition" />
              </div>
              <div>
                <label className="block text-[12px] font-semibold text-[var(--color-botanical-muted)] mb-1.5">Category</label>
                <select value={formData.category} onChange={e => setFormData({ ...formData, category: e.target.value })}
                  className="w-full text-[13px] bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] focus:border-[var(--color-focus)] rounded-lg px-3 py-2 text-[var(--color-botanical-text)] focus:ring-1 focus:ring-[var(--color-focus)] transition">
                  <option value="bouquets">Bouquets</option>
                  <option value="cards">Cards</option>
                  <option value="charms">Charms & Vessels</option>
                  <option value="hampers">Hampers</option>
                  <option value="other">Other</option>
                </select>
              </div>
              <div>
                <label className="block text-[12px] font-semibold text-[var(--color-botanical-muted)] mb-1.5">Category Label</label>
                <input type="text" value={formData.categoryLabel} onChange={e => setFormData({ ...formData, categoryLabel: e.target.value })}
                  placeholder="e.g., Flowers & Bouquets"
                  className="w-full text-[13px] bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] focus:border-[var(--color-focus)] rounded-lg px-3 py-2 text-[var(--color-botanical-text)] placeholder:text-[var(--color-botanical-subtle)] focus:ring-1 focus:ring-[var(--color-focus)] transition" />
              </div>
              <div>
                <label className="block text-[12px] font-semibold text-[var(--color-botanical-muted)] mb-1.5">Badge</label>
                <input type="text" value={formData.badge} onChange={e => setFormData({ ...formData, badge: e.target.value })}
                  placeholder="e.g., Bestseller, New Arrival"
                  className="w-full text-[13px] bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] focus:border-[var(--color-focus)] rounded-lg px-3 py-2 text-[var(--color-botanical-text)] placeholder:text-[var(--color-botanical-subtle)] focus:ring-1 focus:ring-[var(--color-focus)] transition" />
              </div>
              <div>
                <label className="block text-[12px] font-semibold text-[var(--color-botanical-muted)] mb-1.5">Availability</label>
                <select value={formData.availability} onChange={e => setFormData({ ...formData, availability: e.target.value })}
                  className="w-full text-[13px] bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] focus:border-[var(--color-focus)] rounded-lg px-3 py-2 text-[var(--color-botanical-text)] focus:ring-1 focus:ring-[var(--color-focus)] transition">
                  <option value="Ready to Ship">Ready to Ship</option>
                  <option value="Made to Order (3 days)">Made to Order (3 days)</option>
                  <option value="Pre-Order">Pre-Order</option>
                </select>
              </div>
            </div>
          </div>

          <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] p-6 shadow-xs">
            <h2 className="font-serif text-lg text-[var(--color-botanical-primary)] font-medium mb-4">Pricing & Stock</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-[12px] font-semibold text-[var(--color-botanical-muted)] mb-1.5">Price (₹) *</label>
                <input type="number" value={formData.price} onChange={e => setFormData({ ...formData, price: e.target.value })}
                  placeholder="e.g., 1850"
                  className="w-full text-[13px] bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] focus:border-[var(--color-focus)] rounded-lg px-3 py-2 text-[var(--color-botanical-text)] placeholder:text-[var(--color-botanical-subtle)] focus:ring-1 focus:ring-[var(--color-focus)] transition" />
              </div>
              <div>
                <label className="block text-[12px] font-semibold text-[var(--color-botanical-muted)] mb-1.5">Original Price (₹)</label>
                <input type="number" value={formData.originalPrice} onChange={e => setFormData({ ...formData, originalPrice: e.target.value })}
                  placeholder="e.g., 2200"
                  className="w-full text-[13px] bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] focus:border-[var(--color-focus)] rounded-lg px-3 py-2 text-[var(--color-botanical-text)] placeholder:text-[var(--color-botanical-subtle)] focus:ring-1 focus:ring-[var(--color-focus)] transition" />
              </div>
              <div>
                <label className="block text-[12px] font-semibold text-[var(--color-botanical-muted)] mb-1.5">Initial Stock</label>
                <input type="number" value={formData.initialStock} min="0"
                  onChange={e => setFormData({ ...formData, initialStock: e.target.value })}
                  className="w-full text-[13px] bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] focus:border-[var(--color-focus)] rounded-lg px-3 py-2 text-[var(--color-botanical-text)] focus:ring-1 focus:ring-[var(--color-focus)] transition" />
              </div>
              <div>
                <label className="block text-[12px] font-semibold text-[var(--color-botanical-muted)] mb-1.5">Reorder Level</label>
                <input type="number" value={formData.reorderLevel} min="0"
                  onChange={e => setFormData({ ...formData, reorderLevel: e.target.value })}
                  className="w-full text-[13px] bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] focus:border-[var(--color-focus)] rounded-lg px-3 py-2 text-[var(--color-botanical-text)] focus:ring-1 focus:ring-[var(--color-focus)] transition" />
              </div>
              <div className="sm:col-span-2">
                <label className="flex items-center gap-3 cursor-pointer">
                  <input type="checkbox" checked={formData.stockTracked}
                    onChange={e => setFormData({ ...formData, stockTracked: e.target.checked })}
                    className="w-4 h-4 rounded border-[var(--color-botanical-border)] text-[var(--color-botanical-primary)] focus:ring-[var(--color-focus)]" />
                  <span className="text-[12px] font-semibold text-[var(--color-botanical-muted)]">Track inventory for this product</span>
                </label>
                <p className="text-[11px] text-[var(--color-botanical-subtle)] mt-1 ml-7">Enable to manage stock levels and receive low-stock alerts.</p>
              </div>
            </div>
          </div>

          <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] p-6 shadow-xs">
            <h2 className="font-serif text-lg text-[var(--color-botanical-primary)] font-medium mb-4">Materials & Crafting</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="sm:col-span-2">
                <label className="block text-[12px] font-semibold text-[var(--color-botanical-muted)] mb-1.5">Materials</label>
                <input type="text" value={formData.material} onChange={e => setFormData({ ...formData, material: e.target.value })}
                  placeholder="e.g., Cotton chenille stems, mulberry bark paper, silk ribbon"
                  className="w-full text-[13px] bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] focus:border-[var(--color-focus)] rounded-lg px-3 py-2 text-[var(--color-botanical-text)] placeholder:text-[var(--color-botanical-subtle)] focus:ring-1 focus:ring-[var(--color-focus)] transition" />
              </div>
              <div className="sm:col-span-2">
                <label className="block text-[12px] font-semibold text-[var(--color-botanical-muted)] mb-1.5">Dimensions</label>
                <input type="text" value={formData.dimensions} onChange={e => setFormData({ ...formData, dimensions: e.target.value })}
                  placeholder="e.g., Height: ~28 cm · Weight: ~165g"
                  className="w-full text-[13px] bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] focus:border-[var(--color-focus)] rounded-lg px-3 py-2 text-[var(--color-botanical-text)] placeholder:text-[var(--color-botanical-subtle)] focus:ring-1 focus:ring-[var(--color-focus)] transition" />
              </div>
              <div>
                <label className="block text-[12px] font-semibold text-[var(--color-botanical-muted)] mb-1.5">Craft Time</label>
                <input type="text" value={formData.craftTime} onChange={e => setFormData({ ...formData, craftTime: e.target.value })}
                  placeholder="e.g., 4.5 Hours · 14 Stems"
                  className="w-full text-[13px] bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] focus:border-[var(--color-focus)] rounded-lg px-3 py-2 text-[var(--color-botanical-text)] placeholder:text-[var(--color-botanical-subtle)] focus:ring-1 focus:ring-[var(--color-focus)] transition" />
              </div>
            </div>
          </div>

          <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] p-6 shadow-xs">
            <h2 className="font-serif text-lg text-[var(--color-botanical-primary)] font-medium mb-1">3D Studio — Prepare Images</h2>
            <p className="text-[12px] text-[var(--color-botanical-subtle)] mb-3">
              Upload product photographs, images with busy backgrounds or flyers. Backgrounds are removed on the
              server and each image gets a transparent cutout plus a neutral preview for later 3D model generation.
              The original uploads are always kept.
            </p>
            <ReferenceImageStudio
              draftKey={referenceDraftKey}
              onAcceptedChange={setReferenceIds}
              onBusyChange={setStudioBusy}
            />
          </div>

          <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] p-6 shadow-xs">
            <h2 className="font-serif text-lg text-[var(--color-botanical-primary)] font-medium mb-1">Product Images</h2>
            <p className="text-[12px] text-[var(--color-botanical-subtle)] mb-3">The first image is used as the primary storefront photo. Images upload to hosted storage when configured, otherwise to the site's own media storage.</p>
            <ImageUploader images={images} onChange={setImages} />
          </div>

          <div className="flex items-center justify-end gap-3 pt-4">
            <Link to="/admin/products" className="px-5 py-2.5 rounded-full bg-[var(--color-surface-lowest)] text-[var(--color-botanical-muted)] hover:bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] text-[13px] font-semibold transition">
              Cancel
            </Link>
            {studioBusy && !loading && (
              <p className="text-[11px] text-[var(--color-botanical-subtle)] mr-auto">
                Preparing images — saving unlocks when processing finishes.
              </p>
            )}
            <button type="submit" disabled={loading || studioBusy}
              className="px-6 py-2.5 rounded-full bg-[var(--color-btn)] hover:bg-[var(--color-btn-hover-alt)] disabled:opacity-50 text-white text-[13px] font-semibold transition shadow-sm flex items-center gap-2">
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
