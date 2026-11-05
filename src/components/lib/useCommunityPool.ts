import { useEffect, useState } from "react";
import type { TrackMeta } from "@htl/library";
import { fetchCommunity, fetchMeta, putCommunityMeta } from "@htl/media";
import { communityMeta } from "./libraryUtils";

// The shared community pool (tracks already cached — load instantly, no resolve). Legacy
// tracks cached before metadata was stored have no title; backfill them from /api/meta with
// a small concurrency pool, persisting each so it's instant next time and we never re-hammer
// the resolver, and pushing each into the shared pool so every future visitor gets it too.
export function useCommunityPool(refreshKey?: string): TrackMeta[] {
  const [community, setCommunity] = useState<TrackMeta[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetchCommunity(5000)
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

  // ★ THE POOL GROWS WHILE YOU PLAY (operator, 2026-11-05: "when in auto mix, the community list is
  // not being populated properly"). The server indexes a track into the community catalog when it
  // first caches its audio — i.e. when a deck loads it, AUTO's loads included — but this list was
  // fetched once, when the Library opened, so nothing played since ever appeared until a reload.
  // A deck loading a new track (`refreshKey` changes) now refetches it, after a pause that lets the
  // server's background write land. Titles already backfilled here are kept.
  useEffect(() => {
    if (!refreshKey) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      fetchCommunity(5000)
        .then((tracks) => {
          if (cancelled) return;
          setCommunity((cur) => {
            const known = new Map(cur.map((t) => [t.videoId, t]));
            const cache = communityMeta.get();
            return tracks.map((t) => (t.title ? t : { ...t, ...(known.get(t.videoId) ?? cache[t.videoId] ?? {}) }));
          });
        })
        .catch(() => {});
    }, REFRESH_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [refreshKey]);
  return community;
}

const REFRESH_DELAY_MS = 8000;
