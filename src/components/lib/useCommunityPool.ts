import { useEffect, useState } from "react";
import type { TrackMeta } from "@htl/library";
import { fetchCommunity, fetchMeta, putCommunityMeta } from "@htl/media";
import { communityMeta } from "./libraryUtils";

// The shared community pool (tracks already cached — load instantly, no resolve). Legacy
// tracks cached before metadata was stored have no title; backfill them from /api/meta with
// a small concurrency pool, persisting each so it's instant next time and we never re-hammer
// the resolver, and pushing each into the shared pool so every future visitor gets it too.
export function useCommunityPool(): TrackMeta[] {
  const [community, setCommunity] = useState<TrackMeta[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetchCommunity(120)
      .then((tracks) => {
        if (cancelled) return;
        // Apply any titles we backfilled on a previous visit straight away.
        const cache = communityMeta.get();
        const seeded = tracks.map((t) => (t.title ? t : { ...t, ...(cache[t.videoId] ?? {}) }));
        setCommunity(seeded);
        const missing = seeded.filter((t) => !t.title).slice(0, 80);
        let idx = 0;
        const worker = async () => {
          while (!cancelled && idx < missing.length) {
            const t = missing[idx++];
            try {
              const m = await fetchMeta(t.videoId);
              if (cancelled) return;
              communityMeta.set({
                ...communityMeta.get(),
                [t.videoId]: { title: m.title, artist: m.artist, duration: m.duration, thumbnail: m.thumbnail },
              });
              // Persist it to the shared pool so every future visitor gets it too.
              void putCommunityMeta({
                videoId: t.videoId,
                title: m.title,
                artist: m.artist,
                duration: m.duration,
                thumbnail: m.thumbnail,
              });
              setCommunity((cur) => cur.map((x) => (x.videoId === t.videoId ? { ...x, ...m } : x)));
            } catch {
              /* leave the thumbnail-only row */
            }
          }
        };
        void Promise.all(Array.from({ length: Math.min(5, missing.length) }, worker));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return community;
}
