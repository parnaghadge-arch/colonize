import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, fetchPage, type Page, type RequestOptions } from './api.ts';

/**
 * Small data-fetching hook.
 *
 * Deliberately minimal — no cache library, no query keys. It cancels in-flight requests when the
 * path or query changes, so a fast filter change cannot paint a stale list over a fresh one.
 */

export interface Resource<T> {
  data: T | null;
  loading: boolean;
  error: ApiError | null;
  reload: () => void;
}

export function useResource<T>(
  path: string | null,
  query?: RequestOptions['query'],
  deps: unknown[] = [],
): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [error, setError] = useState<ApiError | null>(null);
  const [nonce, setNonce] = useState(0);

  // Serialise the query so `{page:1}` and `{page:1}` compare equal across renders.
  const queryString = query ? JSON.stringify(query) : '';
  const queryRef = useRef(query);
  queryRef.current = query;

  useEffect(() => {
    if (!path) {
      setData(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    api
      .get<T>(path, queryRef.current, controller.signal)
      .then((result) => {
        setData(result);
        setError(null);
      })
      .catch((err: unknown) => {
        if ((err as Error)?.name === 'AbortError') return;
        setError(err instanceof ApiError ? err : new ApiError(String(err), 0, 'UNKNOWN'));
        setData(null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, queryString, nonce, ...deps]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { data, loading, error, reload };
}

/**
 * Paginated collection hook. Returns the rows plus the server's pagination, so a list page can
 * show "1–20 of 1500" and page through it without guessing the total.
 */
export interface ListResult<T> {
  page: Page<T>;
  loading: boolean;
  error: ApiError | null;
  reload: () => void;
}

const EMPTY_PAGE: Page<never> = { items: [], total: 0, page: 1, limit: 20, totalPages: 1 };

export function useList<T>(
  path: string | null,
  query?: RequestOptions['query'],
  deps: unknown[] = [],
): ListResult<T> {
  const [page, setPage] = useState<Page<T>>(EMPTY_PAGE as Page<T>);
  const [loading, setLoading] = useState(path !== null);
  const [error, setError] = useState<ApiError | null>(null);
  const [nonce, setNonce] = useState(0);

  const queryString = query ? JSON.stringify(query) : '';
  const queryRef = useRef(query);
  queryRef.current = query;

  useEffect(() => {
    if (!path) {
      setPage(EMPTY_PAGE as Page<T>);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    fetchPage<T>(path, queryRef.current, controller.signal)
      .then((result) => {
        setPage(result);
        setError(null);
      })
      .catch((err: unknown) => {
        if ((err as Error)?.name === 'AbortError') return;
        setError(err instanceof ApiError ? err : new ApiError(String(err), 0, 'UNKNOWN'));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, queryString, nonce, ...deps]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { page, loading, error, reload };
}

/** Track a pending mutation so a button can show its own spinner and block double submits. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    try {
      return await fn();
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, run };
}
