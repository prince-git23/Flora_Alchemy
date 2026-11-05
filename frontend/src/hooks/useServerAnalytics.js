import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * useServerAnalytics — one analytics read, honestly reported.
 *
 * Analytics panels read the API's own aggregates instead of re-summing the
 * hydrated order list, so each needs the same three states: loading, a real
 * error with a retry, and the payload. Keeping them in one hook stops the
 * overview and the revenue page from drifting apart.
 *
 * The loader lives in a ref so an inline arrow does not restart the request on
 * every render; the caller's `deps` decide when a new read is wanted.
 */
export function useServerAnalytics(loader, deps = []) {
  const [state, setState] = useState({ loading: true, error: '', data: null });
  const [nonce, setNonce] = useState(0);
  const loaderRef = useRef(loader);

  useEffect(() => {
    loaderRef.current = loader;
  }, [loader]);

  useEffect(() => {
    let alive = true;
    setState((prev) => ({ ...prev, loading: true, error: '' }));
    Promise.resolve()
      .then(() => loaderRef.current())
      .then((data) => {
        if (alive) setState({ loading: false, error: '', data: data || null });
      })
      .catch((err) => {
        if (!alive) return;
        setState({ loading: false, error: err?.message || 'Analytics could not be loaded.', data: null });
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const retry = useCallback(() => setNonce((n) => n + 1), []);
  return { ...state, retry };
}

export default useServerAnalytics;
