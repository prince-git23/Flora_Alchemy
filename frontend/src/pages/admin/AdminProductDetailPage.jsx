import React, { useCallback, useMemo, useState, useEffect, lazy, Suspense } from 'react';
import { useStoreVersion } from '../../hooks/useStoreVersion.js';
import { useParams, Link, useNavigate } from 'react-router-dom';
import AdminLayout from '../../components/admin/AdminLayout.jsx';
import ImageUploader from '../../components/admin/ImageUploader.jsx';
import ReferenceImageStudio from '../../components/admin/ReferenceImageStudio.jsx';
import CaptureSetPanel from '../../components/admin/CaptureSetPanel.jsx';
import ThreeGlbPreview from '../../components/admin/ThreeGlbPreview.jsx';
import * as threeGlb from '../../services/threeGlbService.js';

import { getProducts, updateProduct, deleteProduct } from '../../services/productService.js';
import { getInventory, getInventoryHistory } from '../../services/inventoryService.js';
import { formatINR, formatDate } from '../../services/orderService.js';
import { ImageIcon, Loader2 } from 'lucide-react';

const GenerationJobsForProduct = lazy(() => import('../../components/admin/GenerationJobsForProduct.jsx'));

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
  // Phase 20.4 — hoisted above the not-found early return: a hook declared
  // after a conditional return changes the hook count between renders
  // (27 → 28) and crashed every fresh load of this page with
  // "Rendered more hooks than during the previous render".
  const [deleting, setDeleting] = useState(false);
  // 3D Studio — Phase 1. The product already exists here, so the studio works
  // against its slug directly (no draft key) and the accepted images are part
  // of the same save.
  const [referenceIds, setReferenceIds] = useState([]);
  const [studioBusy, setStudioBusy] = useState(false);
  // 3D Model Studio — Phase 2. ONE live preview of whichever model is being
  // looked at: the candidate under review when there is one, otherwise the
  // approved model. Two WebGL contexts on one page is a cost nobody needs.
  const [current3dAsset, setCurrent3dAsset] = useState(null);
  const [reviewTarget, setReviewTarget] = useState(null);
  const [previewError, setPreviewError] = useState('');
  const [previewReload, setPreviewReload] = useState(0);

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

  // Load the product's approved 3D asset, and re-load it whenever the studio
  // approves a replacement.
  const loadCurrent3dAsset = useCallback(async () => {
    if (!product?.slug) return;
    try {
      const asset = await threeGlb.getCurrentAsset(product.slug);
      setCurrent3dAsset(asset);
    } catch (err) {
      setCurrent3dAsset(null);
      setPreviewError(err?.message || 'Could not load the 3D model.');
    }
  }, [product?.slug]);

  useEffect(() => {
    loadCurrent3dAsset();
  }, [loadCurrent3dAsset]);

  // A candidate under review takes precedence over the approved model: looking at
  // the model that needs a decision is the reason the studio was opened.
  const previewAsset = reviewTarget || current3dAsset;

  // The viewer takes an async LOADER, not a URL: model bytes are private and are
  // served behind a bearer token, which only this app can attach to the request.
  const loadPreviewModel = useCallback(() => {
    if (!product?.slug || !previewAsset?.id) {
      return Promise.reject(new Error('No 3D model is available to preview yet.'));
    }
    return threeGlb.loadModelObjectUrl(product.slug, previewAsset.id);
  }, [product?.slug, previewAsset?.id]);

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
              <p className="text-[14px] text-[var(--color-botanical-muted)] mt-1.5">The product "{productId}" does not exist in the catalog.</p>
            </div>
            <Link to="/admin/products" className="inline-block px-5 py-2 rounded-full bg-[var(--color-btn)] text-white text-[13px] font-semibold shadow-xs hover:bg-[var(--color-btn-hover-alt)] transition-colors">
              Return to Products
            </Link>
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
      const saved = await updateProduct(product.id, {
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
        referenceImageIds: referenceIds,
      });
      // The product IS saved even when the reference set could not be attached,
      // so the two outcomes are reported separately instead of pretending the
      // whole save failed.
      if (saved?.referenceHandoff?.error) {
        setSaveError(`Product saved, but the prepared images could not be attached: ${saved.referenceHandoff.error}`);
      } else {
        setEditing(false);
      }
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2500);
    } catch (err) {
      setSaveError(err.message || 'Product could not be saved.');
    } finally {
      setSaving(false);
    }
  };

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
            <Link to="/admin/products" className="p-2 rounded-xl hover:bg-[var(--color-surface-high)] text-[var(--color-botanical-muted)] transition-colors" aria-label="Back to products">
              <span className="material-symbols-outlined text-[20px]">arrow_back</span>
            </Link>
            <div>
              <h1 className="font-serif text-2xl sm:text-3xl text-[var(--color-botanical-primary)] tracking-tight font-normal">{product.name}</h1>
              <p className="text-[13px] text-[var(--color-botanical-subtle)] mt-0.5">
                {product.visibility === 'Hidden' ? 'Hidden from customers' : 'Visible to customers'} · SKU {product.sku || '—'} · {product.price ? `$${product.price.toFixed(2)}` : 'No price set'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {savedFlash && (
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[var(--color-success-soft-bg)] text-[var(--color-success-soft-fg)] text-[11px] font-bold" aria-live="polite">
                <span className="w-1.5 h-1.5 rounded-full bg-current" aria-hidden="true" /> Saved
              </span>
            )}
            {editing ? (
              <>
                <button
                  type="button"
                  onClick={() => { setEditing(false); setSaveError(''); }}
                  className="px-4 py-2 text-[12px] font-semibold text-[var(--color-botanical-muted)] bg-[var(--color-surface-lowest)] hover:bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] rounded-full transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 text-[12px] font-semibold text-white bg-[var(--color-btn)] hover:bg-[var(--color-btn-hover-alt)] rounded-full transition shadow-xs"
                >
                  Save Changes
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => { setEditing(true); setSaveError(''); }}
                className="px-4 py-2 text-[12px] font-semibold text-white bg-[var(--color-btn)] hover:bg-[var(--color-btn-hover-alt)] rounded-full transition shadow-xs"
              >
                Edit Product
              </button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
          {/* Main column */}
          <div className="xl:col-span-2 space-y-6">
            {/* Product hero image */}
            <div className="rounded-2xl overflow-hidden bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)]">
              {product.images?.[0] ? (
                <img
                  src={product.images[0]}
                  alt={product.name}
                  className="w-full h-64 sm:h-80 object-cover"
                  loading="lazy"
                />
              ) : (
                <div className="w-full h-64 sm:h-80 flex items-center justify-center text-[var(--color-botanical-subtle)]">
                  <ImageIcon className="w-10 h-10 opacity-60" aria-hidden="true" />
                  <span className="ml-2 text-sm">No product image</span>
                </div>
              )}
            </div>

            {/* Quick info */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div className="rounded-xl bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] p-4">
                <div className="text-[11px] text-[var(--color-botanical-muted)] uppercase tracking-wider font-medium">SKU</div>
                <div className="mt-1 text-sm font-medium text-[var(--color-botanical-strong)]">{product.sku || '—'}</div>
              </div>
              <div className="rounded-xl bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] p-4">
                <div className="text-[11px] text-[var(--color-botanical-muted)] uppercase tracking-wider font-medium">Price</div>
                <div className="mt-1 text-sm font-medium text-[var(--color-botanical-strong)]">{product.price ? `$${product.price.toFixed(2)}` : '—'}</div>
              </div>
              <div className="rounded-xl bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] p-4">
                <div className="text-[11px] text-[var(--color-botanical-muted)] uppercase tracking-wider font-medium">Stock</div>
                <div className="mt-1 text-sm font-medium text-[var(--color-botanical-strong)]">{product.stockTracked === false ? 'Not tracked' : (inventory ? `${inventory.available} available` : '—')}</div>
              </div>
              <div className="rounded-xl bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] p-4">
                <div className="text-[11px] text-[var(--color-botanical-muted)] uppercase tracking-wider font-medium">Category</div>
                <div className="mt-1 text-sm font-medium text-[var(--color-botanical-strong)]">{product.categoryLabel || '—'}</div>
              </div>
            </div>

            {/* 3D Model Studio — Phase 2 */}
            <section className="rounded-2xl border border-[var(--color-botanical-border)] bg-[var(--color-surface-lowest)] p-5" aria-labelledby="studio-heading">
              <div className="flex items-center justify-between gap-4 mb-4">
                <div>
                  <h2 id="studio-heading" className="font-serif text-lg text-[var(--color-botanical-primary)]">3D Model Studio</h2>
                  {/* The copy names WHAT is on screen: a candidate under review
                      is not an approved model, and the viewport's own loading
                      state says nothing about its review status. */}
                  <p className="text-[11px] text-[var(--color-botanical-muted)] mt-0.5">
                    {reviewTarget
                      ? 'Preview of the candidate awaiting your review — not visible to customers until it is approved.'
                      : 'Interactive preview of the approved 3D model, when one exists.'}
                  </p>
                </div>
                {reviewTarget ? (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-50 text-amber-900 dark:bg-amber-500/15 dark:text-amber-300 text-[11px] font-semibold">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-500" aria-hidden="true" /> Awaiting review
                  </span>
                ) : current3dAsset ? (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-800 text-[11px] font-semibold">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" aria-hidden="true" /> Approved
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[var(--color-surface-container)] text-[var(--color-botanical-muted)] text-[11px] font-semibold">
                    No approved model
                  </span>
                )}
              </div>

              {product.slug ? (
                <ThreeGlbPreview
                  hasModel={Boolean(previewAsset?.hasModel)}
                  loadModel={loadPreviewModel}
                  /* The asset identity, so selecting a different candidate
                     reloads instead of leaving the previous model on screen. */
                  assetKey={previewAsset?.id || ''}
                  reloadKey={previewReload}
                  fallbackUrl={product.images?.[0] || ''}
                  onModelError={(err) => setPreviewError(err?.message || 'Could not load the 3D model.')}
                  orientationYaw={previewAsset?.orientation?.yawQuarterTurns ?? 0}
                  previewHeight={360}
                  label={reviewTarget ? 'Generated 3D model awaiting review' : 'Approved 3D model'}
                  diagnostics
                />
              ) : (
                <div className="flex items-center justify-center" style={{ height: 360 }}>
                  <p className="text-sm text-[var(--color-botanical-subtle)]">Save the product before previewing a model.</p>
                </div>
              )}

              {previewError && (
                <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 p-2.5 dark:border-red-500/30 dark:bg-red-500/10">
                  <p className="text-[11px] text-red-700 dark:text-red-300">{previewError}</p>
                  <button
                    type="button"
                    onClick={() => {
                      setPreviewError('');
                      setPreviewReload((n) => n + 1);
                    }}
                    className="shrink-0 rounded-full border border-red-300 px-2.5 py-1 text-[11px] font-medium text-red-800 dark:border-red-500/40 dark:text-red-300"
                  >
                    Retry
                  </button>
                </div>
              )}
            </section>

            {/* Reference image studio — Phase 1 */}
            <section className="rounded-2xl border border-[var(--color-botanical-border)] bg-[var(--color-surface-lowest)] p-5" aria-labelledby="refs-heading">
              <h2 id="refs-heading" className="font-serif text-lg text-[var(--color-botanical-primary)] mb-1">Prepared Reference Images</h2>
              <p className="text-[11px] text-[var(--color-botanical-muted)] mb-4">Upload and prepare product photographs for 3D generation.</p>
              <ReferenceImageStudio
                productSlug={product.slug}
                acceptedIds={referenceIds}
                onAcceptedChange={setReferenceIds}
                busy={studioBusy}
              />
            </section>

            {/* Multi-view capture — Phase 11. Coverage, per-engine eligibility,
                the exact submission plan and the explicit submit. It reads the
                accepted references above and writes only set-level truth. */}
            {product.slug && (
              <CaptureSetPanel
                productSlug={product.slug}
                disabled={studioBusy}
                onSubmitted={() => loadCurrent3dAsset?.()}
              />
            )}

            {/* 3D Model Studio — Phase 2. Generation, review and approval. It
                reports WHICH asset to preview so this page keeps exactly one
                live WebGL context. */}
            {product.slug && (
              <Suspense
                fallback={
                  <div className="flex items-center gap-2 rounded-2xl border border-[var(--color-botanical-border)] bg-[var(--color-surface-lowest)] p-5 text-[12px] text-[var(--color-botanical-muted)]">
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    Loading the 3D Model Studio…
                  </div>
                }
              >
                <GenerationJobsForProduct
                  productSlug={product.slug}
                  fallbackUrl={product.images?.[0] || ''}
                  onActiveAssetChange={setReviewTarget}
                  onChanged={loadCurrent3dAsset}
                  disabled={studioBusy}
                />
              </Suspense>
            )}

            {/* Description */}
            <div className="rounded-2xl border border-[var(--color-botanical-border)] bg-[var(--color-surface-lowest)] p-5">
              <h2 className="font-serif text-lg text-[var(--color-botanical-primary)] mb-2">Description</h2>
              {editing ? (
                <textarea
                  value={form.description}
                  onChange={set("description")}
                  className="w-full resize-y rounded-xl border border-[var(--color-botanical-border)] bg-[var(--color-surface-low)] p-3 text-[13px]"
                  rows={6}
                  placeholder="Describe this product for customers…"
                />
              ) : (
                <p className="text-[13px] text-[var(--color-botanical-muted)] whitespace-pre-wrap">{product.description || 'No description yet.'}</p>
              )}
            </div>
          </div>

          {/* Sidebar */}
          <div className="space-y-6">
            <div className="rounded-2xl border border-[var(--color-botanical-border)] bg-[var(--color-surface-lowest)] p-4">
              <h3 className="text-[11px] text-[var(--color-botanical-muted)] uppercase tracking-wider font-medium mb-2">Actions</h3>
              <div className="flex flex-col sm:flex-row gap-2">
                {editing ? (
                  <>
                    <button
                      type="button"
                      onClick={() => { setEditing(false); setSaveError(''); }}
                      className="px-3 py-2 text-[12px] font-semibold text-[var(--color-botanical-muted)] bg-[var(--color-surface-lowest)] hover:bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] rounded-full transition"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className="px-3 py-2 text-[12px] font-semibold text-white bg-[var(--color-btn)] hover:bg-[var(--color-btn-hover-alt)] rounded-full transition shadow-xs"
                    >
                      Save Changes
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => { setEditing(true); setSaveError(''); }}
                      className="px-3 py-2 text-[12px] font-semibold text-white bg-[var(--color-btn)] hover:bg-[var(--color-btn-hover-alt)] rounded-full transition shadow-xs"
                    >
                      Edit
                    </button>
                    {product.stockTracked !== false && inventory ? (
                      <button
                        type="button"
                        onClick={() => navigate(`/admin/inventory/${encodeURIComponent(product.id)}`)}
                        className="px-3 py-2 text-[12px] font-semibold text-white bg-[var(--color-btn)] hover:bg-[var(--color-btn-hover-alt)] rounded-full transition shadow-xs"
                      >
                        Inventory
                      </button>
                    ) : null}
                    {product.visibility !== 'Hidden' ? (
                      <button
                        type="button"
                        onClick={() => setConfirmingDelete(true)}
                        className="px-3 py-2 text-[12px] font-semibold text-red-700 bg-red-50 hover:bg-red-100 dark:bg-red-500/15 dark:text-red-300 dark:hover:bg-red-500/25 border border-red-200 dark:border-red-500/30 rounded-full transition"
                      >
                        Hide
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmingDelete(true)}
                        className="px-3 py-2 text-[12px] font-semibold text-red-700 bg-red-50 hover:bg-red-100 dark:bg-red-500/15 dark:text-red-300 dark:hover:bg-red-500/25 border border-red-200 dark:border-red-500/30 rounded-full transition"
                      >
                        Delete
                      </button>
                    )}
                  </>
                )}
              </div>
              {confirmingDelete && (
                <div className="mt-3 p-3 rounded-xl bg-red-50 border border-red-200 text-[12px] text-red-800 dark:bg-red-500/15 dark:border-red-500/30 dark:text-red-300">
                  <p className="font-semibold mb-1">{product.visibility !== 'Hidden' ? 'Hide this product?' : 'Delete this product?'}</p>
                  <p className="text-[11px] opacity-80 mb-2">{product.visibility !== 'Hidden' ? "Customers will no longer see this product." : 'This cannot be undone. Orders already placed will keep their line items.'}</p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setConfirmingDelete(false)}
                      className="px-3 py-1.5 text-[11px] font-semibold rounded-full bg-[var(--color-surface-low)] hover:bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] transition"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={handleDelete}
                      className="px-3 py-1.5 text-[11px] font-semibold text-white bg-red-600 hover:bg-red-700 rounded-full transition shadow-xs"
                    >
                      {product.visibility !== 'Hidden' ? 'Hide' : 'Delete'}
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* 3D Model Studio sidebar — quick status */}
            <div className="rounded-2xl border border-[var(--color-botanical-border)] bg-[var(--color-surface-lowest)] p-4">
              <h3 className="text-[11px] text-[var(--color-botanical-muted)] uppercase tracking-wider font-medium mb-2">3D Model</h3>
              {current3dAsset ? (
                <ul className="space-y-1.5 text-[12px] text-[var(--color-botanical-strong)]">
                  <li className="flex justify-between"><span>Provider</span><span className="text-[var(--color-botanical-muted)]">{current3dAsset.provider || '—'}</span></li>
                  <li className="flex justify-between"><span>Model</span><span className="text-[var(--color-botanical-muted)]">{current3dAsset.model || '—'}</span></li>
                  <li className="flex justify-between"><span>Version</span><span className="text-[var(--color-botanical-muted)]">{current3dAsset.version || '—'}</span></li>
                  <li className="flex justify-between"><span>Textures</span><span className="text-[var(--color-botanical-muted)]">{current3dAsset.validation?.textures ?? 0}</span></li>
                  <li className="flex justify-between"><span>Approved</span><span className="text-[var(--color-botanical-muted)]">{current3dAsset.approval?.approvedAt ? new Date(current3dAsset.approval.approvedAt).toLocaleString() : '—'}</span></li>
                  <li className="flex justify-between"><span>Model size</span><span className="text-[var(--color-botanical-muted)]">{(current3dAsset.bytes || 0) > 0 ? `${(current3dAsset.bytes / 1024).toFixed(1)} KB` : '—'}</span></li>
                </ul>
              ) : (
                <p className="text-[12px] text-[var(--color-botanical-muted)]">No approved model for this product.</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
