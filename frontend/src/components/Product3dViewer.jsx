import React, { useCallback, useState } from 'react';
import { Cuboid } from 'lucide-react';
import ThreeGlbPreview from './admin/ThreeGlbPreview.jsx';
import { loadPublicModelObjectUrl } from '../services/product3dService.js';

/**
 * Product3dViewer — PHASE 3 — the CUSTOMER's 3D view of an approved product
 * model, shown inside the product page's image gallery.
 *
 * WHY IT WRAPS THE STUDIO'S VIEWER INSTEAD OF REPEATING IT. The orbit/zoom/reset
 * viewport, the lazy `import('three')`, the GPU disposal on unmount and the
 * loading/error/empty states already exist in `components/admin/ThreeGlbPreview`
 * (Phase 2). Re-implementing them here would guarantee the two drift apart — the
 * storefront would be the copy that quietly stops disposing its textures. So the
 * viewer is reused verbatim and this component adds only what a STOREFRONT needs:
 *
 *   · the public (credential-free) model loader from `product3dService`;
 *   · a one-line, honest caption (version + provider), and NOTHING else about
 *     the asset: no ids, no storage, no approval trail.
 *
 * The "Back to photos" control deliberately lives OUTSIDE this component, in the
 * product page's view toggle: it is then rendered independently of the
 * viewport's own state machine, so an unavailable WebGL context, a 404 model or
 * a failed parse still leaves the customer one click from the photographs.
 *
 * It is loaded through `React.lazy` by the product page, so neither this file
 * nor `three` reaches the initial storefront bundle.
 *
 * LIFETIME. The object URL created for the GLB is owned by the viewer and
 * revoked when the viewport unmounts or reloads; there is no cache here, by
 * design (see product3dService). Reduced motion: nothing animates on its own —
 * the model is still until the customer drags it.
 */

export default function Product3dViewer({ product3d, productName = 'this product', className = '' }) {
  const deliveryPath = product3d?.delivery?.glb || '';
  const [errorMessage, setErrorMessage] = useState('');

  // Referentially stable: a NEW function identity re-initialises the whole
  // three.js scene, which for a storefront page would look like a flicker on
  // every parent render.
  const loadModel = useCallback(() => loadPublicModelObjectUrl(deliveryPath), [deliveryPath]);

  const onModelError = useCallback((err) => {
    setErrorMessage(err?.message || 'The 3D model could not be loaded.');
  }, []);

  const facts = [
    product3d?.version ? `v${product3d.version}` : '',
    product3d?.provider || '',
  ].filter(Boolean);

  return (
    <div
      className={`relative w-full aspect-square sm:aspect-[4/5] rounded-3xl overflow-hidden bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] shadow-[0_8px_30px_-4px_rgba(46,36,30,0.08)] ${className}`}
      data-testid="product-3d-view"
    >
      <ThreeGlbPreview
        loadModel={loadModel}
        hasModel
        onModelError={onModelError}
        orientationYaw={product3d?.orientationYaw ?? 0}
        className="h-full w-full rounded-none border-0"
        previewHeight={null}
        label={`Three-dimensional model of ${productName}`}
      />

      {/* The "Back to photos" exit lives in the product page's view toggle (see
          BackToPhotosButton) rather than inside this box: it is rendered
          OUTSIDE the viewport's own state machine, so an unavailable WebGL
          context or a 404 model still leaves the customer one click from the
          photographs. */}
      <div className="absolute top-3 left-3 flex items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-botanical-border)] bg-[var(--color-surface)]/95 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-botanical-strong)] shadow-sm">
          <Cuboid className="w-3.5 h-3.5" aria-hidden="true" />
          3D View
        </span>
        {facts.length > 0 && (
          <span className="hidden sm:inline rounded-full border border-[var(--color-botanical-border)] bg-[var(--color-surface)]/95 px-2.5 py-1 text-[10px] text-[var(--color-botanical-subtle)] shadow-sm">
            {facts.join(' · ')}
          </span>
        )}
      </div>

      {errorMessage ? (
        <p
          className="pointer-events-none absolute bottom-3 left-3 right-3 rounded-xl border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 px-3 py-2 text-[11px] text-[var(--color-danger)]"
          role="status"
          data-testid="product-3d-error"
        >
          {errorMessage}
        </p>
      ) : null}
    </div>
  );
}
