import { useCallback, useRef, useState } from "react";
import type { TrackMeta } from "../library/types";
import { fetchRecommendations } from "../media/recommend";
import { rankByMixability, smartSortChain } from "./mixability";
import type { MixMode } from "./types";

// The auto-mix queue: the ordered list of tracks the AutoMixer will play next.
//
// Two fill modes:
//   - playlist: seeded from a fixed track list (optionally smart-sorted into a
//     nearest-mixability chain).
//   - radio: kept topped up from the YouTube watch-next graph of whatever's
//     playing, ranked by mixability against it.
//
// The hook is intentionally UI-agnostic state + async fill; the AutoMixer drives
// it (peekNext/advance) and the MixQueuePanel renders it.

export interface MixQueue {
  mode: MixMode;
  current: TrackMeta | null; // what the queue considers now-playing
  upcoming: TrackMeta[];
  smartSort: boolean;
  setMode: (m: MixMode) => void;
  setSmartSort: (on: boolean) => void;
  /** Replace the queue with a fixed list (the "Auto-mix this playlist" entry). */
  loadTracks: (tracks: TrackMeta[], opts?: { smartSort?: boolean; mode?: MixMode }) => void;
  /** Mark a track as the now-playing seed (also records it as played). */
  setCurrent: (t: TrackMeta | null) => void;
  /** Latest now-playing seed, read through a ref (safe from a captured closure). */
  getCurrent: () => TrackMeta | null;
  /** Pop the next track into `current` and return it (records it played). */
  advance: () => TrackMeta | null;
  peekNext: () => TrackMeta | null;
  /** Ensure at least one track is queued (radio mode tops up from `seed`), then
   *  return the next. */
  ensureNext: (seed: TrackMeta | null) => Promise<TrackMeta | null>;
  enqueue: (t: TrackMeta) => void; // append
  enqueueNext: (t: TrackMeta) => void; // jump the queue
  remove: (videoId: string) => void;
  reorder: (from: number, to: number) => void;
  clear: () => void;
}

const RADIO_MIN_AHEAD = 3; // keep at least this many tracks queued in radio mode

export function useMixQueue(): MixQueue {
  const [mode, setModeState] = useState<MixMode>("playlist");
  const [smartSort, setSmartSortState] = useState(false);
  const [items, setItems] = useState<TrackMeta[]>([]);
  const [current, setCurrentState] = useState<TrackMeta | null>(null);

  // Non-rendering bookkeeping.
  const played = useRef<Set<string>>(new Set());
  const filling = useRef(false);
  // Mirror current state into refs so the imperative API (called from the
  // AutoMixer tick / async fill) always sees the latest without stale closures.
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const currentRef = useRef(current);
  currentRef.current = current;
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const setMode = useCallback((m: MixMode) => setModeState(m), []);

  const setSmartSort = useCallback((on: boolean) => {
    setSmartSortState(on);
    if (on) setItems((cur) => smartSortChain(cur));
  }, []);

  const loadTracks = useCallback((tracks: TrackMeta[], opts?: { smartSort?: boolean; mode?: MixMode }) => {
    const sort = opts?.smartSort ?? false;
    played.current = new Set();
    setSmartSortState(sort);
    if (opts?.mode) setModeState(opts.mode);
    setCurrentState(null);
    setItems(sort ? smartSortChain(tracks) : tracks.slice());
  }, []);

  const setCurrent = useCallback((t: TrackMeta | null) => {
    if (t) played.current.add(t.videoId);
    setCurrentState(t);
  }, []);

  const advance = useCallback((): TrackMeta | null => {
    const next = itemsRef.current[0] ?? null;
    if (!next) return null;
    played.current.add(next.videoId);
    setItems((cur) => cur.slice(1));
    setCurrentState(next);
    return next;
  }, []);

  const peekNext = useCallback((): TrackMeta | null => itemsRef.current[0] ?? null, []);

  const getCurrent = useCallback((): TrackMeta | null => currentRef.current, []);

  const ensureNext = useCallback(async (seed: TrackMeta | null): Promise<TrackMeta | null> => {
    if (modeRef.current === "radio" && itemsRef.current.length < RADIO_MIN_AHEAD && seed?.videoId && !filling.current) {
      filling.current = true;
      try {
        const recs = await fetchRecommendations(seed.videoId, { provider: seed.provider ?? null });
        const fresh = recs.filter(
          (t) =>
            t.videoId &&
            !played.current.has(t.videoId) &&
            t.videoId !== currentRef.current?.videoId &&
            !itemsRef.current.some((q) => q.videoId === t.videoId),
        );
        const ranked = rankByMixability(seed, fresh);
        if (ranked.length) setItems((cur) => [...cur, ...ranked]);
      } catch {
        /* recommendations are best-effort — queue just stays as-is */
      } finally {
        filling.current = false;
      }
    }
    return itemsRef.current[0] ?? null;
  }, []);

  const enqueue = useCallback((t: TrackMeta) => {
    setItems((cur) => (cur.some((x) => x.videoId === t.videoId) ? cur : [...cur, t]));
  }, []);

  const enqueueNext = useCallback((t: TrackMeta) => {
    setItems((cur) => [t, ...cur.filter((x) => x.videoId !== t.videoId)]);
  }, []);

  const remove = useCallback((videoId: string) => {
    setItems((cur) => cur.filter((t) => t.videoId !== videoId));
  }, []);

  const reorder = useCallback((from: number, to: number) => {
    setItems((cur) => {
      if (from < 0 || from >= cur.length || to < 0 || to >= cur.length || from === to) return cur;
      const next = cur.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    played.current = new Set();
    setItems([]);
    setCurrentState(null);
  }, []);

  return {
    mode,
    current,
    upcoming: items,
    smartSort,
    setMode,
    setSmartSort,
    loadTracks,
    setCurrent,
    getCurrent,
    advance,
    peekNext,
    ensureNext,
    enqueue,
    enqueueNext,
    remove,
    reorder,
    clear,
  };
}
