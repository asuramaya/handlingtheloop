import { useEffect, useReducer } from "react";
import { cacheState, primeCachePool, subscribeCacheStatus } from "@htl/media";

// Subscribe a list component (Library table / Search results) to cache-pool updates:
// primes the shared manifest once and re-renders when it (or a later refresh) lands,
// so the pips appear without a reload. Returns a version counter that bumps on each
// manifest change — callers that *filter* by cache state (not just render pips) fold it
// into their memo deps so the filtered view recomputes when the manifest arrives.
export function useCacheStatus(): number {
  const [ver, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    primeCachePool();
    return subscribeCacheStatus(() => bump());
  }, []);
  return ver;
}

// Compact, at-a-glance cache markers for a track row: a green dot when the song is
// cached (loads instantly, no resolve/download) and a blue dot when its stems are
// cached too. Renders nothing when neither is cached, so it only draws attention to
// what's special rather than dotting every row.
export function CachePips({ videoId }: { videoId: string }) {
  const { song, stems } = cacheState(videoId);
  if (!song && !stems) return null;
  const title = stems ? "Cached + stems — loads instantly" : "Cached — loads instantly";
  return (
    <span className="cache-pips" title={title} aria-label={title}>
      {song && <span className="pip pip-song" />}
      {stems && <span className="pip pip-stems" />}
    </span>
  );
}
