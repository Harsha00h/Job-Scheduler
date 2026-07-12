import { useCallback, useEffect, useRef, useState } from 'react';
import { subscribe } from './live';

// Live-updating data hook: loads immediately, refreshes on WebSocket job
// events (throttled), and keeps a slow poll as fallback for when the
// socket is down. refresh() lets mutations trigger an immediate reload.
export function usePoll(loader, deps = [], intervalMs = 10000) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const savedLoader = useRef(loader);
  savedLoader.current = loader;
  const lastRefresh = useRef(0);

  const refresh = useCallback(() => {
    lastRefresh.current = Date.now();
    savedLoader
      .current()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, intervalMs);
    // live path: any job event triggers a refresh, at most once per second
    const unsubscribe = subscribe(() => {
      if (Date.now() - lastRefresh.current > 1000) refresh();
    });
    return () => {
      clearInterval(timer);
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, refresh };
}
