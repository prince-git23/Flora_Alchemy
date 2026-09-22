import React, { useState, useMemo } from 'react';
import { useStoreVersion } from '../../hooks/useStoreVersion.js';
import { Link, useNavigate } from 'react-router-dom';
import AdminLayout from '../../components/admin/AdminLayout.jsx';
import { getCollections, createCollection, deleteCollection } from '../../services/collectionService.js';
import { formatDate } from '../../services/orderService.js';
import { Plus, Trash2, AlertCircle } from 'lucide-react';

/**
 * Admin Collections — real CRUD surface.
 *
 * Create → createCollection() → POST /api/collections → MongoDB
 * Delete → deleteCollection() → DELETE /api/collections/:slug → MongoDB
 * Edit/membership → detail page (Edit Collection panel).
 */
export default function AdminCollectionsPage() {
  const storeVersion = useStoreVersion();
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [createError, setCreateError] = useState('');
  const [creating, setCreating] = useState(false);
  const [newCollection, setNewCollection] = useState({ name: '', description: '', visibility: 'Visible' });
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [deleteError, setDeleteError] = useState('');

  const collections = useMemo(() => getCollections(), [storeVersion]);

  const filtered = useMemo(() => {
    let list = [...collections];
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter((c) => c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q));
    }
    return list;
  }, [collections, searchQuery]);

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!newCollection.name.trim() || newCollection.name.trim().length < 2) {
      setCreateError('Collection name is required (2+ characters).');
      return;
    }
    setCreating(true);
    setCreateError('');
    try {
      const created = await createCollection({
        name: newCollection.name.trim(),
        description: newCollection.description.trim(),
        visibility: newCollection.visibility,
      });
      setShowCreate(false);
      setNewCollection({ name: '', description: '', visibility: 'Visible' });
      navigate(`/admin/collections/${created.id}`);
    } catch (err) {
      setCreateError(err.message || 'Collection could not be created.');
    } finally {
      setCreating(false);
    }
  };

  const [deletingId, setDeletingId] = useState(null);
  const handleDelete = async (id) => {
    if (deletingId) return; // duplicate guard
    setDeleteError('');
    setDeletingId(id);
    try {
      await deleteCollection(id);
      setConfirmDeleteId(null);
    } catch (err) {
      setDeleteError(err.message || 'Collection could not be deleted.');
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <AdminLayout>
      <div className="max-w-7xl mx-auto space-y-6 pb-12">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="font-serif text-3xl sm:text-4xl text-[var(--color-botanical-primary)] tracking-tight font-normal">Collections</h1>
            <p className="text-[14px] text-[var(--color-botanical-muted)] mt-1">Curated product collections and seasonal groupings</p>
          </div>
          <button
            type="button"
            onClick={() => { setShowCreate(true); setCreateError(''); }}
            className="px-5 py-2.5 rounded-full bg-[var(--color-btn)] text-white text-[13px] font-semibold hover:bg-[var(--color-btn-hover-alt)] transition-colors flex items-center gap-2 shadow-sm"
          >
            <Plus className="w-4 h-4" aria-hidden="true" />
            New Collection
          </button>
        </div>

        {/* Create panel */}
        {showCreate && (
          <form onSubmit={handleCreate} className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] p-6 shadow-xs space-y-4" noValidate>
            <h2 className="font-serif text-lg text-[var(--color-botanical-primary)] font-medium">Create Collection</h2>
            {createError && (
              <div className="p-3 rounded-xl bg-[var(--color-badge-bg)]/70 text-[var(--color-badge-fg-strong)] text-[13px] flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
                {createError}
              </div>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="col-name" className="block text-[12px] font-semibold text-[var(--color-botanical-muted)] mb-1.5">Name *</label>
                <input id="col-name" type="text" value={newCollection.name}
                  onChange={(e) => setNewCollection((f) => ({ ...f, name: e.target.value }))} required
                  placeholder="e.g., Monsoon Edit"
                  className="w-full text-[13px] bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] focus:border-[var(--color-focus)] rounded-lg px-3 py-2 text-[var(--color-botanical-text)] placeholder:text-[var(--color-botanical-subtle)] focus:ring-1 focus:ring-[var(--color-focus)] transition" />
              </div>
              <div>
                <label htmlFor="col-vis" className="block text-[12px] font-semibold text-[var(--color-botanical-muted)] mb-1.5">Visibility</label>
                <select id="col-vis" value={newCollection.visibility}
                  onChange={(e) => setNewCollection((f) => ({ ...f, visibility: e.target.value }))}
                  className="w-full text-[13px] bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] focus:border-[var(--color-focus)] rounded-lg px-3 py-2 text-[var(--color-botanical-text)] focus:ring-1 focus:ring-[var(--color-focus)] transition">
                  <option value="Visible">Visible — shown in the shop</option>
                  <option value="Hidden">Hidden — staff only</option>
                </select>
              </div>
              <div className="sm:col-span-2">
                <label htmlFor="col-desc" className="block text-[12px] font-semibold text-[var(--color-botanical-muted)] mb-1.5">Description</label>
                <textarea id="col-desc" value={newCollection.description} rows={2}
                  onChange={(e) => setNewCollection((f) => ({ ...f, description: e.target.value }))}
                  className="w-full text-[13px] bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] focus:border-[var(--color-focus)] rounded-lg px-3 py-2 text-[var(--color-botanical-text)] focus:ring-1 focus:ring-[var(--color-focus)] transition resize-none" />
              </div>
            </div>
            <div className="flex items-center justify-end gap-2">
              <button type="button" onClick={() => { setShowCreate(false); setCreateError(''); }}
                className="px-4 py-2 rounded-full border border-[var(--color-botanical-border)] text-[12px] font-semibold text-[var(--color-botanical-muted)] hover:bg-[var(--color-surface-low)] transition">
                Cancel
              </button>
              <button type="submit" disabled={creating}
                className="px-5 py-2 rounded-full bg-[var(--color-btn)] text-white text-[12px] font-semibold hover:bg-[var(--color-btn-hover-alt)] transition disabled:opacity-50">
                {creating ? 'Creating…' : 'Create Collection'}
              </button>
            </div>
          </form>
        )}

        {/* Filters */}
        <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] p-3.5 shadow-xs">
          <div className="relative max-w-md">
            <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-[16px] text-[var(--color-botanical-subtle)]">search</span>
            <input type="search" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder="Search collections..." aria-label="Search collections"
              className="w-full text-[13px] bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] focus:border-[var(--color-focus)] rounded-lg pl-9 pr-3 py-1.5 text-[var(--color-botanical-text)] placeholder:text-[var(--color-botanical-subtle)] focus:ring-1 focus:ring-[var(--color-focus)] transition" />
          </div>
        </div>

        {deleteError && (
          <div className="p-3 rounded-xl bg-[var(--color-badge-bg)]/70 text-[var(--color-badge-fg-strong)] text-[13px] flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
            {deleteError}
          </div>
        )}

        {/* Empty State */}
        {filtered.length === 0 && (
          <div className="p-12 sm:p-16 bg-[var(--color-surface-lowest)] rounded-2xl text-center space-y-4 shadow-xs border border-[var(--color-botanical-border)]">
            <div className="w-16 h-16 rounded-full bg-[var(--color-surface-low)] mx-auto flex items-center justify-center text-[var(--color-botanical-subtle)]">
              <span className="material-symbols-outlined text-[32px]">auto_stories</span>
            </div>
            <div className="max-w-md mx-auto">
              <h3 className="font-serif text-2xl text-[var(--color-botanical-primary)] font-medium">No Collections Found</h3>
              <p className="text-[14px] text-[var(--color-botanical-muted)] mt-1.5">No collections match your current search.</p>
            </div>
            <button type="button" onClick={() => setSearchQuery('')} className="px-5 py-2 rounded-full bg-[var(--color-btn)] text-white text-[13px] font-semibold shadow-xs hover:bg-[var(--color-btn-hover-alt)] transition-colors">Clear Search</button>
          </div>
        )}

        {/* Collections Grid */}
        {filtered.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {filtered.map((col) => (
              <div key={col.id} className="relative bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] shadow-xs hover:shadow-md hover:border-[var(--color-botanical-border)] transition-all overflow-hidden group">
                {confirmDeleteId === col.id ? (
                  <div className="p-5 space-y-3">
                    <p className="text-[13px] font-semibold text-[#8a2a18]">Delete &quot;{col.name}&quot;?</p>
                    <p className="text-[12px] text-[var(--color-botanical-muted)]">Products stay in the catalogue — only the grouping is removed.</p>
                    <div className="flex gap-2">
                      <button type="button" onClick={() => handleDelete(col.id)} disabled={deletingId !== null}
                        className="px-4 py-2 rounded-full bg-[#ba1a1a] text-white text-[11px] font-semibold hover:bg-[#8a2a18] transition disabled:opacity-50 flex items-center gap-1.5">
                        {deletingId === col.id && (
                          <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" aria-hidden="true" />
                        )}
                        {deletingId === col.id ? 'Deleting…' : 'Delete'}
                      </button>
                      <button type="button" onClick={() => setConfirmDeleteId(null)}
                        className="px-4 py-2 rounded-full bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] text-[11px] font-semibold text-[var(--color-botanical-primary)] hover:bg-[var(--color-surface-low)] transition">
                        Keep
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <Link to={`/admin/collections/${col.id}`} className="block">
                      <div className="aspect-[16/9] bg-[var(--color-surface-low)] overflow-hidden">
                        <img src={col.coverImage} alt="" className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" loading="lazy" />
                      </div>
                      <div className="p-5 space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] uppercase font-bold tracking-wider text-[var(--color-botanical-subtle)]">Collection</span>
                          <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${col.visibility === 'Visible' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300' : 'bg-[var(--color-badge-bg)] text-[var(--color-badge-fg-strong)]'}`}>{col.visibility}</span>
                        </div>
                        <h3 className="font-serif text-[17px] text-[var(--color-botanical-primary)] font-medium leading-snug">{col.name}</h3>
                        <p className="text-[13px] text-[var(--color-botanical-muted)] line-clamp-2">{col.description || 'No description.'}</p>
                        <div className="flex items-center justify-between pt-2 border-t border-[var(--color-botanical-border-light)] text-[12px]">
                          <span className="text-[var(--color-botanical-subtle)]">{col.productCount} product{col.productCount !== 1 ? 's' : ''}</span>
                          <span className="text-[var(--color-botanical-subtle)]">Created {formatDate(col.createdAt)}</span>
                        </div>
                      </div>
                    </Link>
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteId(col.id)}
                      className="absolute top-2 right-2 p-1.5 rounded-full bg-[var(--color-surface-lowest)]/95 shadow text-[var(--color-danger)] hover:bg-[#ffdad6] transition-opacity"
                      aria-label={`Delete collection ${col.name}`}
                      title="Delete collection"
                    >
                      <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
