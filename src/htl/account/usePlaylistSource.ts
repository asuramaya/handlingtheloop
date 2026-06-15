import { useCallback, useEffect, useRef, useState } from "react";
import { Store } from "../persistence";

// Smart cache for a provider's playlist LIST. Providers have no change webhooks, so
// the list must be fetched — but reopening the library, switching tabs, or a
// connection re-check shouldn't re-hit the API every time. So:
//   - the last result is PERSISTED (shown instantly on reopen, survives reloads),
//   - a fetch only happens when the cache is STALE (older than the TTL) or FORCED
//     (the ⟳ button),
//   - stale-while-revalidate: cached items show immediately while a background
//     refresh runs, and a failed refresh keeps the cached list instead of blanking.

interface Cached {
  at: number;
  items: unknown[];
}
const store = new Store<Record<string, Cached>>("htl:playlistLists", {}, 1);
const TTL_MS = 5 * 60_000; // consider a list fresh for 5 minutes

export type SourceState = "idle" | "loading" | "error";

export interface PlaylistSource<T> {
  items: T[];
  state: SourceState;
  err: string;
  /** Force a refetch (the ⟳ button), bypassing the freshness check. */
  refresh: () => Promise<void>;
}

export function usePlaylistSource<T>(key: string, fetcher: () => Promise<T[]>, enabled: boolean): PlaylistSource<T> {
  const [items, setItems] = useState<T[]>(() => (store.get()[key]?.items as T[] | undefined) ?? []);
  const [state, setState] = useState<SourceState>("idle");
  const [err, setErr] = useState("");
  const inflight = useRef(false);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const run = useCallback(
    async (force: boolean) => {
      if (inflight.current) return;
      const cached = store.get()[key];
      if (cached) setItems(cached.items as T[]); // show what we have immediately
      const fresh = cached && Date.now() - cached.at < TTL_MS;
      if (!force && fresh) {
        setState("idle");
        return; // smart: skip the fetch entirely when the list is still fresh
      }
      inflight.current = true;
      setState(cached ? "idle" : "loading"); // no spinner if we can show cached (revalidate quietly)
      setErr("");
      try {
        const next = await fetcher();
        setItems(next);
        const all = store.get();
        all[key] = { at: Date.now(), items: next as unknown[] };
        store.set(all);
        setState("idle");
      } catch (e) {
        setErr((e as Error).message);
        setState(itemsRef.current.length ? "idle" : "error"); // keep cached on failure
      } finally {
        inflight.current = false;
      }
    },
    [key, fetcher],
  );

  // On connect / first enable: fetch only if stale (run() decides).
  useEffect(() => {
    if (enabled) void run(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  const refresh = useCallback(() => run(true), [run]);
  return { items, state, err, refresh };
}
