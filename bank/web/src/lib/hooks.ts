import { useCallback, useEffect, useRef, useState } from 'react';

export interface AsyncState<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  reload: () => void;
}

export function useAsync<T>(load: () => Promise<T>, deps: readonly unknown[], pollMs?: number, keepPolling: (data: T) => boolean = () => true): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const loadRef = useRef(load);
  const keepRef = useRef(keepPolling);
  loadRef.current = load;
  keepRef.current = keepPolling;
  const depsKey = deps.map(String).join('|');

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const run = async (first: boolean) => {
      if (first) setLoading(true);
      try {
        const result = await loadRef.current();
        if (cancelled) return;
        setData(result);
        setError(null);
        if (pollMs && keepRef.current(result)) timer = setTimeout(() => void run(false), pollMs);
      } catch (caught) {
        if (cancelled) return;
        setError(caught);
        if (pollMs) timer = setTimeout(() => void run(false), pollMs * 2);
      } finally {
        if (!cancelled && first) setLoading(false);
      }
    };
    void run(true);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [depsKey, version, pollMs]);

  const reload = useCallback(() => setVersion((value) => value + 1), []);
  return { data, error, loading, reload };
}

export function useTick(intervalMs: number): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return tick;
}

export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title;
  }, [title]);
}
