import React, { useMemo, useState, useEffect } from 'react';
import { useStoreVersion } from '../../hooks/useStoreVersion.js';
import { useParams, Link, useNavigate } from 'react-router-dom';
import AdminLayout from '../../components/admin/AdminLayout.jsx';
import { getCollectionById, updateCollection } from '../../services/collectionService.js';
import { getProducts } from '../../services/productService.js';
import { formatDate, formatINR } from '../../services/orderService.js';
import { Save, AlertCircle, Check, X } from 'lucide-react';

/**
 * Admin Collection Detail — view + EDIT.
 *
 * Edit form → updateCollection() → PATCH /api/collections/:slug → MongoDB
 *           → server response → store refresh → UI reflects saved state.
 *
 * Editable: name, description, visibility, and product membership.
 * (Cover image editing joins the product-image upload workflow once the
 * media endpoint is wired to a hosted provider; membership and copy are the
 * day-to-day operations and are fully server-persisted here.)
 */
export default function AdminCollectionDetailPage() {
  const { collectionId } = useParams();
  const storeVersion = useStoreVersion();
  const navigate = useNavigate();

  const collection = useMemo(() => getCollectionById(collectionId), [collectionId, storeVersion]);
  const allProducts = useMemo(() => getProducts(), [storeVersion]);

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [savedFlash, setSavedFlash] = useState(false);
  const [memberQuery, setMemberQuery] = useState('');

  useEffect(() => {
    if (!collection) return;
    setForm({
      name: collection.name || '',
      description: collection.description || '',
      visibility: collection.visibility === 'Hidden' ? 'Hidden' : 'Visible',
      productIds: [...(collection.productIds || [])],
    });
  }, [collection?.id]);

  if (!collection || !form) {
    return (
      <AdminLayout>
        <div className="max-w-7xl mx-auto pb-12">
          <div className="p-12 sm:p-16 bg-[var(--color-surface-lowest)] rounded-2xl text-center space-y-4 shadow-xs border border-[var(--color-botanical-border)]">
            <div className="w-16 h-16 rounded-full bg-[var(--color-surface-low)] mx-auto flex items-center justify-center text-[var(--color-botanical-subtle)]">
              <span className="material-symbols-outlined text-[32px]">search_off</span>
            </div>
            <div className="max-w-md mx-auto">
              <h3 className="font-serif text-2xl text-[var(--color-botanical-primary)] font-medium">Collection Not Found</h3>
              <p className="text-[14px] text-[var(--color-botanical-muted)] mt-1.5">The collection &quot;{collectionId}&quot; does not exist.</p>
            </div>
            <Link to="/admin/collections" className="inline-block px-5 py-2 rounded-full bg-[var(--color-btn)] text-white text-[13px] font-semibold shadow-xs hover:bg-[var(--color-btn-hover-alt)] transition-colors">Return to Collections</Link>
          </div>
        </div>
      </AdminLayout>
    );
  }

  const members = form.productIds
    .map((pid) => allProducts.find((p) => p.id === pid))
    .filter(Boolean);

  const available = allProducts
    .filter((p) => !form.productIds.includes(p.id))
    .filter((p) => {
      if (!memberQuery.trim()) return true;
      const q = memberQuery.toLowerCase();
      return p.name.toLowerCase().includes(q) || (p.categoryLabel || '').toLowerCase().includes(q);
    });

  const addMember = (id) => setForm((f) => ({ ...f, productIds: [...f.productIds, id] }));
  const removeMember = (id) => setForm((f) => ({ ...f, productIds: f.productIds.filter((x) => x !== id) }));

  const handleSave = async (e) => {
    e.preventDefault();
    if (!form.name.trim() || form.name.trim().length < 2) {
      setSaveError('Collection name is required.');
      return;
    }
    setSaving(true);
    setSaveError('');
    try {
      await updateCollection(collection.id, {
        name: form.name.trim(),
        description: form.description.trim(),
        visibility: form.visibility,
        productIds: form.productIds,
      });
      setEditing(false);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2500);
    } catch (err) {
      setSaveError(err.message || 'Collection could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <AdminLayout>
      <div className="max-w-7xl mx-auto space-y-6 pb-12">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Link to="/admin/collections" className="p-2 rounded-xl hover:bg-[var(--color-surface-high)] text-[var(--color-botanical-muted)] transition-colors" aria-label="Back to collections">
              <span className="material-symbols-outlined text-[20px]">arrow_back</span>
            </Link>
            <div>
              <h1 className="font-serif text-2xl sm:text-3xl text-[var(--color-botanical-primary)] tracking-tight font-normal">{collection.name}</h1>
              <p className="text-[13px] text-[var(--color-botanical-subtle)] mt-0.5">
                {collection.productCount} products · {collection.visibility} · Created {formatDate(collection.createdAt)}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {savedFlash && (
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[var(--color-success-soft-bg)] text-[var(--color-success-soft-fg)] text-[11px] font-bold">
                <Check className="w-3.5 h-3.5" aria-hidden="true" /> Saved
              </span>
            )}
            {!editing ? (
              <button
                type="button"
                onClick={() => { setEditing(true); setSaveError(''); }}
                className="px-4 py-2 text-[12px] font-semibold text-white bg-[var(--color-btn)] hover:bg-[var(--color-btn-hover-alt)] rounded-full transition shadow-xs"
              >
                Edit Collection
              </button>
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

        {editing ? (
          /* ── EDIT FORM ─────────────────────────────────────────────── */
          <form onSubmit={handleSave} className="space-y-6" noValidate>
            {saveError && (
              <div className="p-3 rounded-xl bg-[var(--color-badge-bg)]/70 text-[var(--color-badge-fg-strong)] text-[13px] flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
                {saveError}
              </div>
            )}
            <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] p-6 shadow-xs space-y-4">
              <h2 className="font-serif text-lg text-[var(--color-botanical-primary)] font-medium">Collection Details</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="col-name" className="block text-[12px] font-semibold text-[var(--color-botanical-muted)] mb-1.5">Name *</label>
                  <input id="col-name" type="text" value={form.name}
                    onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} required
                    className="w-full text-[13px] bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] focus:border-[var(--color-focus)] rounded-lg px-3 py-2 text-[var(--color-botanical-text)] focus:ring-1 focus:ring-[var(--color-focus)] transition" />
                </div>
                <div>
                  <label htmlFor="col-vis" className="block text-[12px] font-semibold text-[var(--color-botanical-muted)] mb-1.5">Storefront Visibility</label>
                  <select id="col-vis" value={form.visibility}
                    onChange={(e) => setForm((f) => ({ ...f, visibility: e.target.value }))}
                    className="w-full text-[13px] bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] focus:border-[var(--color-focus)] rounded-lg px-3 py-2 text-[var(--color-botanical-text)] focus:ring-1 focus:ring-[var(--color-focus)] transition">
                    <option value="Visible">Visible — shown in the shop</option>
                    <option value="Hidden">Hidden — staff only</option>
                  </select>
                </div>
                <div className="sm:col-span-2">
                  <label htmlFor="col-desc" className="block text-[12px] font-semibold text-[var(--color-botanical-muted)] mb-1.5">Description</label>
                  <textarea id="col-desc" value={form.description} rows={3}
                    onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                    className="w-full text-[13px] bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] focus:border-[var(--color-focus)] rounded-lg px-3 py-2 text-[var(--color-botanical-text)] focus:ring-1 focus:ring-[var(--color-focus)] transition resize-none" />
                </div>
              </div>
            </div>

            {/* Membership editor */}
            <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] p-6 shadow-xs space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="font-serif text-lg text-[var(--color-botanical-primary)] font-medium">Products in Collection ({members.length})</h2>
              </div>

              {members.length > 0 && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {members.map((p) => (
                    <div key={p.id} className="flex items-center gap-3 p-2.5 rounded-xl bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)]">
                      <div className="w-10 h-10 rounded-lg overflow-hidden bg-[var(--color-surface-lowest)] shrink-0">
                        <img
                          loading="lazy"
                          decoding="async" src={p.images?.[0] || ''} alt="" className="w-full h-full object-cover" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-[12px] font-semibold text-[var(--color-botanical-primary)] truncate">{p.shortName || p.name}</p>
                        <p className="text-[11px] text-[var(--color-botanical-subtle)]">{formatINR(p.price)}</p>
                      </div>
                      <button type="button" onClick={() => removeMember(p.id)}
                        className="p-1.5 rounded-full text-[var(--color-danger)] hover:bg-[#ffdad6]/60"
                        aria-label={`Remove ${p.name} from collection`}>
                        <X className="w-4 h-4" aria-hidden="true" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div>
                <label htmlFor="member-search" className="block text-[12px] font-semibold text-[var(--color-botanical-muted)] mb-1.5">Add products</label>
                <input id="member-search" type="search" value={memberQuery}
                  onChange={(e) => setMemberQuery(e.target.value)}
                  placeholder="Search catalogue…"
                  className="w-full max-w-md text-[13px] bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] focus:border-[var(--color-focus)] rounded-lg px-3 py-2 text-[var(--color-botanical-text)] placeholder:text-[var(--color-botanical-subtle)] focus:ring-1 focus:ring-[var(--color-focus)] transition" />
              </div>
              {available.length > 0 ? (
                <div className="max-h-60 overflow-y-auto grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {available.slice(0, 20).map((p) => (
                    <button key={p.id} type="button" onClick={() => addMember(p.id)}
                      className="flex items-center gap-3 p-2.5 rounded-xl border border-[var(--color-botanical-border)] hover:bg-[var(--color-surface-low)] text-left transition-colors">
                      <div className="w-10 h-10 rounded-lg overflow-hidden bg-[var(--color-surface-low)] shrink-0">
                        <img
                          loading="lazy"
                          decoding="async" src={p.images?.[0] || ''} alt="" className="w-full h-full object-cover" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-[12px] font-semibold text-[var(--color-botanical-primary)] truncate">{p.shortName || p.name}</p>
                        <p className="text-[11px] text-[var(--color-botanical-subtle)]">{p.categoryLabel}</p>
                      </div>
                      <span className="text-[16px] text-[var(--color-botanical-subtle)]" aria-hidden="true">+</span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="text-[12px] text-[var(--color-botanical-subtle)]">All matching products are already in this collection.</p>
              )}
            </div>

            <div className="flex items-center justify-end gap-3">
              <button type="button" onClick={() => { setEditing(false); setSaveError(''); }}
                className="px-5 py-2.5 rounded-full bg-[var(--color-surface-lowest)] text-[var(--color-botanical-muted)] hover:bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] text-[13px] font-semibold transition">
                Cancel
              </button>
              <button type="submit" disabled={saving}
                className="px-6 py-2.5 rounded-full bg-[var(--color-btn)] hover:bg-[var(--color-btn-hover-alt)] disabled:opacity-50 text-white text-[13px] font-semibold transition shadow-sm flex items-center gap-2">
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
          <>
            <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] overflow-hidden shadow-xs">
              <div className="aspect-[3/1] bg-[var(--color-surface-low)]">
                <img
                  loading="lazy"
                  decoding="async" src={collection.coverImage} alt="" className="w-full h-full object-cover" />
              </div>
              <div className="p-6">
                <p className="text-[14px] text-[var(--color-botanical-muted)] leading-relaxed">{collection.description || 'No description yet — use Edit Collection to add one.'}</p>
              </div>
            </div>

            <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] p-6 shadow-xs">
              <h2 className="font-serif text-lg text-[var(--color-botanical-primary)] font-medium mb-4">Products in Collection</h2>
              {members.length === 0 ? (
                <p className="text-[13px] text-[var(--color-botanical-subtle)]">No products yet — use Edit Collection to add some.</p>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {members.map((product) => (
                    <Link key={product.id} to={`/admin/products/${product.id}`}
                      className="flex items-center gap-4 p-3 rounded-xl bg-[var(--color-surface-low)] hover:bg-[var(--color-surface-container)] border border-[var(--color-botanical-border)] transition-all group">
                      <div className="w-16 h-16 rounded-xl overflow-hidden shrink-0 bg-[var(--color-surface-lowest)]">
                        <img src={product.images?.[0] || ''} alt="" className="w-full h-full object-cover" loading="lazy" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-[13px] font-semibold text-[var(--color-botanical-primary)] truncate group-hover:text-[var(--color-accent)] transition-colors">{product.shortName || product.name}</p>
                        <p className="text-[11px] text-[var(--color-botanical-subtle)]">{product.categoryLabel || product.category}</p>
                        <p className="text-[13px] font-bold text-[var(--color-botanical-primary)] mt-0.5">{formatINR(product.price)}</p>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </AdminLayout>
  );
}
