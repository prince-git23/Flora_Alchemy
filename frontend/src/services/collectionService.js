import api from './apiClient.js';
import { store, signalDataChanged, commitStore } from './dataStore.js';
import { getProducts } from './productService.js';

/**
 * Phase 3C — collectionService is backed by the API; no local collection DB.
 */
function fromApiCollection(c) {
  return {
    id: c.slug,
    slug: c.slug,
    name: c.name,
    description: c.description || '',
    coverImage: c.image || '/assets/images/flora-asset-10.jpg',
    productIds: c.productSlugs || [],
    productSlugs: c.productSlugs || [],
    productCount: (c.productSlugs || []).length,
    visibility: c.visibility === 'Hidden' ? 'Hidden' : 'Public',
    createdAt: c.createdAt,
  };
}

export function getCollections() {
  return store.collections.map(fromApiCollection);
}

export function getCollectionById(id) {
  const raw = store.collections.find((c) => c.slug === id);
  return raw ? fromApiCollection(raw) : null;
}

export function getCollectionProducts(id) {
  const collection = getCollectionById(id);
  if (!collection) return [];
  const catalog = getProducts();
  return collection.productIds
    .map((pid) => catalog.find((p) => p.id === pid))
    .filter(Boolean);
}

function toApiPayload(data) {
  return {
    name: data.name,
    description: data.description || '',
    image: data.coverImage || data.image || '',
    productSlugs: data.productIds || data.productSlugs || [],
    visibility: data.visibility === 'Hidden' ? 'Hidden' : 'Visible',
  };
}

export async function createCollection(data) {
  const res = await api.post('/collections', toApiPayload(data), { scope: 'admin' });
  if (!res.ok) throw new Error(res.message || 'Collection could not be created.');
  store.collections = [...store.collections, res.data.collection];
  commitStore();
  // Phase 20.1 — targeted slice refresh (collections only); no duplicate
  // full-catalogue re-hydration, no global loader.
  signalDataChanged('data', ['collections']);
  return fromApiCollection(res.data.collection);
}

export async function updateCollection(id, data) {
  const res = await api.patch(`/collections/${encodeURIComponent(id)}`, toApiPayload(data), {
    scope: 'admin',
  });
  if (!res.ok) throw new Error(res.message || 'Collection could not be updated.');
  const c = res.data.collection;
  store.collections = [...store.collections.filter((x) => x.slug !== c.slug), c];
  commitStore();
  signalDataChanged('data', ['collections']);
  return fromApiCollection(c);
}

export async function deleteCollection(id) {
  const res = await api.delete(`/collections/${encodeURIComponent(id)}`, { scope: 'admin' });
  if (!res.ok) throw new Error(res.message || 'Collection could not be deleted.');
  store.collections = store.collections.filter((x) => x.slug !== id);
  commitStore();
  signalDataChanged('data', ['collections']);
  return store.collections;
}
