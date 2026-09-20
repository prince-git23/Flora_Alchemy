import { useSyncExternalStore } from 'react';
import { subscribeStore, getStoreVersion } from '../services/dataStore.js';

/**
 * Phase 18.5.2 — action-level loading.
 *
 * Pages snapshot the data store once via useMemo(() => getX(), []). Without
 * this hook, a targeted store update (commitStore) was invisible to them and
 * the app relied on the global fa:refresh remount to show fresh data.
 *
 * useStoreVersion() subscribes the component to the store version. When a
 * mutation commits server-confirmed data, the page re-renders IN PLACE —
 * scroll, filters, expanded rows and form state are all preserved. The
 * return value is only an invalidation counter: pass it into the useMemo
 * dependency that snapshots the store.
 *
 * Example:
 *   const storeVersion = useStoreVersion();
 *   const inventory = useMemo(() => getInventory(), [storeVersion]);
 */
export function useStoreVersion() {
  return useSyncExternalStore(subscribeStore, getStoreVersion, getStoreVersion);
}
