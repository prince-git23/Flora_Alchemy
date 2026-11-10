import api from './apiClient.js';
import { fromApiProduct } from './productService.js';

/**
 * Catalogue transport for the homepage's hero / featured set.
 *
 * This is intentionally a thin service, not a second store: it asks the one
 * public `/api/catalogue` endpoint for the ordered projection and normalises
 * each row with the same `fromApiProduct` mapper every other storefront surface
 * uses. ETag metadata is returned to the hook so a conditional GET can answer
 * 304 without rebuilding the list.
 */
export async function fetchCatalogue({ featured = false, hero = false, etag = '' } = {}) {
  const params = new URLSearchParams();
  if (featured) params.set('featured', 'true');
  if (hero) params.set('hero', 'true');
  const query = params.toString();
  const res = await api.getWithMeta(`/catalogue${query ? `?${query}` : ''}`, {
    scope: null,
    headers: etag ? { 'If-None-Match': etag } : {},
  });
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      message: res.message || 'The catalogue could not be loaded.',
      code: res.code || 'CATALOGUE_ERROR',
    };
  }
  if (res.notModified) {
    return { ok: true, notModified: true, etag: res.etag || etag, items: null };
  }
  const rows = Array.isArray(res.data?.items) ? res.data.items : [];
  return {
    ok: true,
    notModified: false,
    etag: res.etag || '',
    items: rows.map(fromApiProduct),
  };
}
