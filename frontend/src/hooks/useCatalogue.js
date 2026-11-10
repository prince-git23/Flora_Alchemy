import { useCallback, useEffect, useState } from 'react';
import { fetchCatalogue } from '../services/catalogueService.js';

/**
 * useCatalogue — stale-while-revalidate for the homepage's public catalogue.
 *
 * Cache scope is the query itself. A cached answer renders immediately, then a
 * conditional GET revalidates it (the server answers 304 when nothing changed).
 * On failure the last good items stay on screen and the error is exposed; the
 * caller decides whether to show a skeleton or the static hero.
 *
 * The hook also listens for `fa:refresh`, which the product service emits after
 * a catalogue write, so adding/updating a product in the portal does not wait
 * for a page reload or a full 30s TTL.
 */
const TTL_MS = 30 * 1000;
const cache = new Map();

function cacheKey({ featured, hero }) {
  return `${featured ? 'featured' : ''}:${hero ? 'hero' : ''}`;
}

export function useCatalogue({ featured = false, hero = false } = {}) {
  const key = cacheKey({ featured, hero });
  const [reloadKey, setReloadKey] = useState(0);
  const [state, setState] = useState(() => {
    const hit = cache.get(key);
    return {
      items: hit?.items || [],
      loading: !hit,
      revalidating: false,
      error: null,
      updatedAt: hit?.updatedAt || 0,
    };
  });

  const refresh = useCallback(() => {
    cache.delete(key);
    setReloadKey((n) => n + 1);
  }, [key]);

  useEffect(() => {
    let alive = true;
    const hit = cache.get(key);
    if (hit) {
      setState({
        items: hit.items,
        loading: false,
        revalidating: false,
        error: null,
        updatedAt: hit.updatedAt,
      });
    } else {
      setState((prev) => ({ ...prev, loading: true }));
    }

    const fresh = hit && Date.now() - hit.updatedAt < TTL_MS && reloadKey === 0;
    if (fresh) return undefined;

    setState((prev) => ({ ...prev, revalidating: Boolean(hit), loading: !hit }));
    fetchCatalogue({ featured, hero, etag: hit?.etag || '' })
      .then((res) => {
        if (!alive) return;
        if (!res.ok) {
          setState((prev) => ({
            ...prev,
            loading: false,
            revalidating: false,
            error: res.message || 'The catalogue could not be loaded.',
          }));
          return;
        }
        if (res.notModified) {
          const updated = { ...hit, etag: res.etag || hit?.etag || '', updatedAt: Date.now() };
          cache.set(key, updated);
          setState({
            items: updated.items,
            loading: false,
            revalidating: false,
            error: null,
            updatedAt: updated.updatedAt,
          });
          return;
        }
        const entry = { items: res.items || [], etag: res.etag || '', updatedAt: Date.now() };
        cache.set(key, entry);
        setState({
          items: entry.items,
          loading: false,
          revalidating: false,
          error: null,
          updatedAt: entry.updatedAt,
        });
      })
      .catch((err) => {
        if (!alive) return;
        setState((prev) => ({
          ...prev,
          loading: false,
          revalidating: false,
          error: err?.message || 'The catalogue could not be loaded.',
        }));
      });

    return () => {
      alive = false;
    };
  }, [key, featured, hero, reloadKey]);

  useEffect(() => {
    const onRefresh = () => refresh();
    window.addEventListener('fa:refresh', onRefresh);
    return () => window.removeEventListener('fa:refresh', onRefresh);
  }, [refresh]);

  return { ...state, refresh };
}

/** Test hook / explicit invalidation after a catalogue write. */
export function clearCatalogueCache() {
  cache.clear();
}
