import React, { useMemo, useState, useEffect } from 'react';
import { useStoreVersion } from '../../hooks/useStoreVersion.js';
import { useParams, Link, useNavigate } from 'react-router-dom';
import AdminLayout from '../../components/admin/AdminLayout.jsx';
import ImageUploader from '../../components/admin/ImageUploader.jsx';
import { getProducts, updateProduct, deleteProduct } from '../../services/productService.js';
import { getInventory, getInventoryHistory } from '../../services/inventoryService.js';
import { formatINR, formatDate } from '../../services/orderService.js';
import { Save, AlertCircle, Check, Trash2, X } from 'lucide-react';

/**
 * Admin Product Detail + EDIT.
 *
 * Phase 14: this page previously rendered read-only information while its
 * route implied edit capability. It now provides a real edit workflow:
 *
 *   Edit form → updateProduct() → PATCH /api/products/:slug → MongoDB
 *             → server response → store refresh → UI reflects saved state
 *
 * Delete also calls the backend, which now removes the linked inventory
 * record so no orphan rows remain.
 */
export default function AdminProductDetailPage() {
  const storeVersion = useStoreVersion();
  const { productId } = useParams();
  const navigate = useNavigate();

  const products = useMemo(() => getProducts(), [storeVersion]);
  const inventoryData = useMemo(() => getInventory(), [storeVersion]);
  const history = useMemo(() => getInventoryHistory(), [storeVersion]);
  const product = useMemo(() => products.find((p) => p.id === productId) || null, [products, productId]);
  const inventory = useMemo(() => inventoryData.find((i) => i.productSlug === productId || i.productId === productId) || null, [inventoryData, productId]);
  const productHistory = useMemo(
    () => history.filter((h) => h.sku === inventory?.sku).slice(0, 5),
    [history, inventory]
  );

  // ── Edit state ──────────────────────────────────────────────────────────
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [savedFlash, setSavedFlash] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  useEffect(() => {
    if (!product) return;
    setForm({
      name: product.name || '',
      description: product.description || '',
      sku: product.sku || '',
      price: String(product.price ?? ''),
      categoryLabel: product.categoryLabel || 'Flowers & Bouquets',
      visibility: product.visibility === 'Hidden' ? 'Hidden' : 'Visible',
      images: product.images || [],
      palette: product.palette || '',
      ribbon: product.ribbon || '',
      stockTracked: product.stockTracked !== false,
    });
  }, [product?.id]);

  if (!product || !form) {
    return (
      <AdminLayout>
        <div className="max-w-7xl mx-auto pb-12">
          <div className="p-12 sm:p-16 bg-[var(--color-surface-lowest)] rounded-2xl text-center space-y-4 shadow-xs border border-[var(--color-botanical-border)]">
            <div className="w-16 h-16 rounded-full bg-[var(--color-surface-low)] mx-auto flex items-center justify-center text-[var(--color-botanical-subtle)]">
              <span className="material-symbols-outlined text-[32px]">search_off</span>
            </div>
            <div className="max-w-md mx-auto">
              <h3 className="font-serif text-2xl text-[var(--color-botanical-primary)] font-medium">Product Not Found</h3>
              <p className="text-[14px] text-[var(--color-botanical-muted)] mt-1.5">The product &quot;{productId}&quot; does not exist in the catalog.</p>
            </div>
            <Link to="/admin/products" className="inline-block px-5 py-2 rounded-full bg-[#180f0a] text-white text-[13px] font-semibold shadow-xs hover:bg-[#2e241e] transition-colors">Return to Products</Link>
          </div>
        </div>
      </AdminLayout>
    );
  }

  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

  const handleSave = async (e) => {
    e.preventDefault();
    if (!form.name.trim() || form.name.trim().length < 2) {
      setSaveError('Product name is required.');
      return;
    }
    const priceNum = Number(form.price);
    if (!Number.isFinite(priceNum) || priceNum < 0) {
      setSaveError('Price must be a non-negative number.');
      return;
    }
    setSaving(true);
    setSaveError('');
    try {
      await updateProduct(product.id, {
        name: form.name.trim(),
        description: form.description,
        sku: form.sku,
        price: priceNum,
        categoryLabel: form.categoryLabel,
        visibility: form.visibility,
        images: form.images,
        palette: form.palette,
        ribbon: form.ribbon,
        stockTracked: form.stockTracked,
      });
      setEditing(false);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2500);
    } catch (err) {
      setSaveError(err.message || 'Product could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const [deleting, setDeleting] = useState(false);
  const handleDelete = async () => {
    if (deleting) return; // duplicate guard
    setDeleteError('');
    setDeleting(true);
    try {
      await deleteProduct(product.id);
      navigate('/admin/products');
    } catch (err) {
      setDeleteError(err.message || 'Product could not be deleted.');
      setConfirmingDelete(false);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <AdminLayout>
      <div className="max-w-7xl mx-auto space-y-6 pb-12">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Link to="/admin/products" className="p-2 rounded-xl hover:bg-[#ebe8e3] text-[var(--color-botanical-muted)] transition-colors" aria-label="Back to products">
              <span className="material-symbols-outlined text-[20px]">arrow_back</span>
            </Link>
            <div>
              <h1 className="font-serif text-2xl sm:text-3xl text-[var(--color-botanical-primary)] tracking-tight font-normal">{product.name}</h1>
              <p className="text-[13px] text-[var(--color-botanical-subtle)] mt-0.5">
                {product.categoryLabel} · SKU: {inventory?.sku || product.sku || 'N/A'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {savedFlash && (
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[#d8e7cd] text-[#081405] text-[11px] font-bold">
                <Check className="w-3.5 h-3.5" aria-hidden="true" /> Saved
              </span>
            )}
            {!editing ? (
              <>
                <button
                  type="button"
                  onClick={() => { setEditing(true); setSaveError(''); }}
                  className="px-4 py-2 text-[12px] font-semibold text-white bg-[#180f0a] hover:bg-[#2e241e] rounded-full transition shadow-xs"
                >
                  Edit Product
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(true)}
                  className="px-4 py-2 text-[12px] font-semibold text-[#ba1a1a] bg-[var(--color-surface-lowest)] hover:bg-[#ffdad6]/50 border border-[#ffdad6] rounded-full transition"
                  aria-label="Delete product"
                >
                  <Trash2 className="w-3.5 h-3.5 inline mr-1" aria-hidden="true" /> Delete
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => { setEditing(false); setSaveError(''); }}
                className="px-4 py-2 text-[12px] font-semibold text-[var(--color-botanical-muted)] bg-[var(--color-surface-lowest)] hover:bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] rounded-full transition"
              >
                <X className="w-3.5 h-3.5 inline mr-1" aria-hidden="true" /> Cancel Editing
              </button>
            )}
          </div>
        </div>

        {/* Delete confirmation */}
        {confirmingDelete && (
          <div className="p-5 rounded-2xl bg-[#ffdad6]/40 border border-[#e8b3a6] space-y-3">
            <p className="text-[14px] font-semibold text-[#8a2a18]">
              Delete &quot;{product.name}&quot;? This also removes its inventory record. Orders history is kept.
            </p>
            {deleteError && <p className="text-[12px] text-[#ba1a1a] font-medium">{deleteError}</p>}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleDelete}
                disabled={deleting}
                className="px-5 py-2.5 rounded-full bg-[#ba1a1a] text-white text-[12px] font-semibold hover:bg-[#8a2a18] transition-colors disabled:opacity-50 flex items-center gap-1.5"
              >
                {deleting && (
                  <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" aria-hidden="true" />
                )}
                {deleting ? 'Deleting…' : 'Yes, Delete Product'}
              </button>
              <button
                type="button"
                onClick={() => { setConfirmingDelete(false); setDeleteError(''); }}
                className="px-5 py-2.5 rounded-full bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] text-[var(--color-botanical-primary)] text-[12px] font-semibold hover:bg-[var(--color-surface-low)] transition-colors"
              >
                Keep Product
              </button>
            </div>
          </div>
        )}

        {editing ? (
          /* ── EDIT FORM ─────────────────────────────────────────────── */
          <form onSubmit={handleSave} className="space-y-6" noValidate>
            {saveError && (
              <div className="p-3 rounded-xl bg-[#ffdad3]/70 text-[#783020] text-[13px] flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
                {saveError}
              </div>
            )}
            <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] p-6 shadow-xs space-y-4">
              <h2 className="font-serif text-lg text-[var(--color-botanical-primary)] font-medium">Product Details</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="sm:col-span-2">
                  <label htmlFor="edit-name" className="block text-[12px] font-semibold text-[var(--color-botanical-muted)] mb-1.5">Name *</label>
                  <input id="edit-name" type="text" value={form.name} onChange={set('name')} required
                    className="w-full text-[13px] bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] focus:border-[#180f0a] rounded-lg px-3 py-2 text-[var(--color-botanical-text)] focus:ring-1 focus:ring-[#180f0a] transition" />
                </div>
                <div className="sm:col-span-2">
                  <label htmlFor="edit-desc" className="block text-[12px] font-semibold text-[var(--color-botanical-muted)] mb-1.5">Description</label>
                  <textarea id="edit-desc" value={form.description} onChange={set('description')} rows={3}
                    className="w-full text-[13px] bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] focus:border-[#180f0a] rounded-lg px-3 py-2 text-[var(--color-botanical-text)] focus:ring-1 focus:ring-[#180f0a] transition resize-none" />
                </div>
                <div>
                  <label htmlFor="edit-sku" className="block text-[12px] font-semibold text-[var(--color-botanical-muted)] mb-1.5">SKU</label>
                  <input id="edit-sku" type="text" value={form.sku} onChange={set('sku')}
                    className="w-full text-[13px] bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] focus:border-[#180f0a] rounded-lg px-3 py-2 text-[var(--color-botanical-text)] focus:ring-1 focus:ring-[#180f0a] transition" />
                </div>
                <div>
                  <label htmlFor="edit-price" className="block text-[12px] font-semibold text-[var(--color-botanical-muted)] mb-1.5">Price (₹) *</label>
                  <input id="edit-price" type="number" min="0" value={form.price} onChange={set('price')} required
                    className="w-full text-[13px] bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] focus:border-[#180f0a] rounded-lg px-3 py-2 text-[var(--color-botanical-text)] focus:ring-1 focus:ring-[#180f0a] transition" />
                </div>
                <div>
                  <label htmlFor="edit-cat" className="block text-[12px] font-semibold text-[var(--color-botanical-muted)] mb-1.5">Category</label>
                  <select id="edit-cat" value={form.categoryLabel} onChange={set('categoryLabel')}
                    className="w-full text-[13px] bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] focus:border-[#180f0a] rounded-lg px-3 py-2 text-[var(--color-botanical-text)] focus:ring-1 focus:ring-[#180f0a] transition">
                    {['Flowers & Bouquets', 'Handmade Cards', 'Charms & Vessels', 'Custom Gifts & Hampers', 'Other'].map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="edit-vis" className="block text-[12px] font-semibold text-[var(--color-botanical-muted)] mb-1.5">Storefront Visibility</label>
                  <select id="edit-vis" value={form.visibility} onChange={set('visibility')}
                    className="w-full text-[13px] bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] focus:border-[#180f0a] rounded-lg px-3 py-2 text-[var(--color-botanical-text)] focus:ring-1 focus:ring-[#180f0a] transition">
                    <option value="Visible">Visible — shown in the shop</option>
                    <option value="Hidden">Hidden — staff only</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="edit-palette" className="block text-[12px] font-semibold text-[var(--color-botanical-muted)] mb-1.5">Palette</label>
                  <input id="edit-palette" type="text" value={form.palette} onChange={set('palette')}
                    className="w-full text-[13px] bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] focus:border-[#180f0a] rounded-lg px-3 py-2 text-[var(--color-botanical-text)] focus:ring-1 focus:ring-[#180f0a] transition" />
                </div>
                <div>
                  <label htmlFor="edit-ribbon" className="block text-[12px] font-semibold text-[var(--color-botanical-muted)] mb-1.5">Ribbon</label>
                  <input id="edit-ribbon" type="text" value={form.ribbon} onChange={set('ribbon')}
                    className="w-full text-[13px] bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] focus:border-[#180f0a] rounded-lg px-3 py-2 text-[var(--color-botanical-text)] focus:ring-1 focus:ring-[#180f0a] transition" />
                </div>
                <div className="sm:col-span-2">
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input type="checkbox" checked={form.stockTracked} onChange={(e) => setForm((f) => ({ ...f, stockTracked: e.target.checked }))}
                      className="w-4 h-4 rounded border-[var(--color-botanical-border)] text-[var(--color-botanical-primary)] focus:ring-[#180f0a]" />
                    <span className="text-[12px] font-semibold text-[var(--color-botanical-muted)]">Track inventory for this product</span>
                  </label>
                </div>
              </div>
            </div>

            <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] p-6 shadow-xs">
              <h2 className="font-serif text-lg text-[var(--color-botanical-primary)] font-medium mb-3">Product Images</h2>
              <ImageUploader images={form.images} onChange={(imgs) => setForm((f) => ({ ...f, images: imgs }))} />
            </div>

            <div className="flex items-center justify-end gap-3">
              <button type="button" onClick={() => { setEditing(false); setSaveError(''); }}
                className="px-5 py-2.5 rounded-full bg-[var(--color-surface-lowest)] text-[var(--color-botanical-muted)] hover:bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] text-[13px] font-semibold transition">
                Cancel
              </button>
              <button type="submit" disabled={saving}
                className="px-6 py-2.5 rounded-full bg-[#180f0a] hover:bg-[#2e241e] disabled:opacity-50 text-white text-[13px] font-semibold transition shadow-sm flex items-center gap-2">
                {saving ? (
                  <>
                    <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" aria-hidden="true" />
                    Saving…
                  </>
                ) : (
                  <>
                    <Save className="w-4 h-4" aria-hidden="true" />
                    Save Changes
                  </>
                )}
              </button>
            </div>
          </form>
        ) : (
          /* ── READ VIEW ─────────────────────────────────────────────── */
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 space-y-6">
              <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] p-6 shadow-xs">
                <h2 className="font-serif text-lg text-[var(--color-botanical-primary)] font-medium mb-4">Product Images</h2>
                <div className="grid grid-cols-3 sm:grid-cols-5 gap-3">
                  {product.images.map((img, idx) => (
                    <div key={idx} className="aspect-square rounded-xl bg-[var(--color-surface-low)] overflow-hidden border border-[var(--color-botanical-border-light)]">
                      <img src={img} alt={`${product.name} ${idx + 1}`} className="w-full h-full object-cover" loading="lazy" />
                    </div>
                  ))}
                </div>
              </div>

              <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] p-6 shadow-xs">
                <h2 className="font-serif text-lg text-[var(--color-botanical-primary)] font-medium mb-4">Description</h2>
                <p className="text-[14px] text-[var(--color-botanical-muted)] leading-relaxed">{product.description || 'No description yet.'}</p>
                <div className="mt-4 space-y-2 text-[13px]">
                  <div className="flex justify-between py-1 border-b border-[var(--color-botanical-border-light)]"><span className="text-[var(--color-botanical-subtle)]">Palette</span><span className="font-medium text-[var(--color-botanical-primary)]">{product.palette || '—'}</span></div>
                  <div className="flex justify-between py-1 border-b border-[var(--color-botanical-border-light)]"><span className="text-[var(--color-botanical-subtle)]">Ribbon</span><span className="font-medium text-[var(--color-botanical-primary)]">{product.ribbon || '—'}</span></div>
                  <div className="flex justify-between py-1"><span className="text-[var(--color-botanical-subtle)]">Craft Time</span><span className="font-medium text-[var(--color-botanical-primary)]">{product.craftTime || '—'}</span></div>
                </div>
              </div>

              {productHistory.length > 0 && (
                <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] p-6 shadow-xs">
                  <h2 className="font-serif text-lg text-[var(--color-botanical-primary)] font-medium mb-4">Recent Inventory Activity</h2>
                  <div className="divide-y divide-[#f0ede9]">
                    {productHistory.map((h) => (
                      <div key={h.id} className="py-3 flex items-start gap-3">
                        <span className={`material-symbols-outlined text-[18px] mt-0.5 ${h.type === 'Restock' ? 'text-[#5b6d54]' : h.type === 'Adjustment' ? 'text-[#964735]' : 'text-[var(--color-botanical-subtle)]'}`}>
                          {h.type === 'Restock' ? 'add_circle' : h.type === 'Adjustment' ? 'edit' : 'shopping_bag'}
                        </span>
                        <div className="flex-1">
                          <p className="text-[13px] text-[var(--color-botanical-text)]">{h.notes}</p>
                          <p className="text-[11px] text-[var(--color-botanical-subtle)] mt-0.5">{formatDate(h.date)} · {h.type} · {h.quantityChange > 0 ? '+' : ''}{h.quantityChange} units</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="space-y-6">
              <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] p-6 shadow-xs">
                <h2 className="font-serif text-lg text-[var(--color-botanical-primary)] font-medium mb-4">Pricing</h2>
                <div className="space-y-3 text-[13px]">
                  <div className="flex justify-between"><span className="text-[var(--color-botanical-subtle)]">Current Price</span><span className="font-bold text-[var(--color-botanical-primary)] text-lg">{formatINR(product.price)}</span></div>
                  <div className="flex justify-between pt-2 border-t border-[var(--color-botanical-border-light)]"><span className="text-[var(--color-botanical-subtle)]">Visibility</span>
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${product.visibility === 'Visible' ? 'bg-emerald-50 text-emerald-700' : 'bg-[#ffdad3] text-[#783020]'}`}>{product.visibility}</span>
                  </div>
                </div>
              </div>

              <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] p-6 shadow-xs">
                <h2 className="font-serif text-lg text-[var(--color-botanical-primary)] font-medium mb-4">Inventory</h2>
                {inventory ? (
                  <div className="space-y-3 text-[13px]">
                    <div className="flex justify-between"><span className="text-[var(--color-botanical-subtle)]">Current Stock</span><span className={`font-bold text-lg ${inventory.currentStock <= inventory.reorderLevel ? 'text-[#964735]' : 'text-[var(--color-botanical-primary)]'}`}>{inventory.currentStock} units</span></div>
                    <div className="flex justify-between"><span className="text-[var(--color-botanical-subtle)]">Reorder Level</span><span className="font-medium text-[var(--color-botanical-primary)]">{inventory.reorderLevel} units</span></div>
                    <div className="flex justify-between"><span className="text-[var(--color-botanical-subtle)]">Status</span>
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${inventory.status === 'In Stock' ? 'bg-emerald-50 text-emerald-700' : inventory.status === 'Critical' ? 'bg-red-50 text-red-700' : 'bg-[#ffdad3] text-[#783020]'}`}>{inventory.status}</span>
                    </div>
                  </div>
                ) : (
                  <p className="text-[13px] text-[var(--color-botanical-subtle)]">No inventory record — made-to-order item or not yet created.</p>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
