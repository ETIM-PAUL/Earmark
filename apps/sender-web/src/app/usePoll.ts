import { useCallback, useEffect, useRef, useState } from "react";

/** Load now, then every `ms`, and again on demand with `refresh`. */
export function usePoll<T>(load: () => Promise<T>, ms: number) {
  const [state, setState] = useState<{ value?: T; error?: Error }>({});
  const loadRef = useRef(load);
  loadRef.current = load;
  const refresh = useCallback(async () => {
    try {
      const value = await loadRef.current();
      setState({ value });
    } catch (e) {
      setState((s) => ({ ...s, error: e as Error }));
    }
  }, []);
  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), ms);
    return () => clearInterval(id);
  }, [ms, refresh]);
  return { ...state, refresh };
}
