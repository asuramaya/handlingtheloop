import { useCallback, useRef, useState } from "react";
import type { TrackMeta } from "../library/types";
import { fetchRecommendations } from "../media/recommend";
import { fetchAnalysisBatch } from "../media/api";
import { avgMixability, smartSortChain, songCore } from "./mixability";
import type { MixMode } from "./types";

// The auto-mix queue: the ordered list of tracks the AutoMixer will play next.
//
// Fill sources:
//   - playlist: a fixed track list (optionally smart-sorted, optionally AUGMENTED
//     with provider radio when it runs low).
//   - radio: kept topped up from the provider watch-next graph of BOTH loaded
//     decks, ranked by an aggregate of provider relatedness + harmonic/tempo fit.
//
// The provider graph (YouTube/Tidal radio) is genre/vibe aware — it won't suggest
// Jeezy after Fishmans — so it is the BACKBONE of ranking; the local key/BPM
// analysis refines it (and we batch-fetch known analysis so it actually engages).

export interface MixQueue {
  mode: MixMode;
  current: TrackMeta | null;
  upcoming: TrackMeta[];
  smartSort: boolean;
  augment: boolean; // playlist mode: top up with provider radio when it runs low
  setMode: (m: MixMode) => void;
  setSmartSort: (on: boolean) => void;
  setAugment: (on: boolean) => void;
  loadTracks: (tracks: TrackMeta[], opts?: { smartSort?: boolean; mode?: MixMode }) => void;
  setCurrent: (t: TrackMeta | null) => void;
  getCurrent: () => TrackMeta | null;
  advance: () => TrackMeta | null;
  peekNext: () => TrackMeta | null;
  /** Ensure the queue is topped up. `seeds` = the loaded-deck tracks to draw radio
   *  from (radio mode, or playlist+augment). Returns the next track. */
  ensureNext: (seeds: TrackMeta | TrackMeta[] | null) => Promise<TrackMeta | null>;
  /** Patch known BPM/key/ISRC onto a queued/current track (from background precompute
   *  + fingerprint identification). */
  patchAnalysis: (videoId: string, a: { bpm?: number | null; key?: string | null; isrc?: string | null }) => void;
  /** Radio mode: drop the upcoming suggestions (they were for the OLD seed) so the
   *  queue re-fills from the now-current track. No-op in playlist mode. */
  reseedRadio: () => void;
  enqueue: (t: TrackMeta) => void;
  enqueueNext: (t: TrackMeta) => void;
  remove: (videoId: string) => void;
  reorder: (from: number, to: number) => void;
  /** Move the track with `videoId` to slot `to` — id-based so a remote's reorder lands on the
   *  RIGHT track even though its from-index was stale against the live queue. No-op if absent. */
  moveById: (videoId: string, to: number) => void;
  /** Take over an in-flight queue when this device becomes the session anchor, so the
   *  host→guest stream continues 1:1 instead of resetting to empty on handover. Preserves
   *  mode (radio keeps refilling; a fixed playlist stays fixed) and the now-playing track. */
  adopt: (tracks: TrackMeta[], cur: TrackMeta | null, m: MixMode) => void;
  clear: () => void;
}

const RADIO_MIN_AHEAD = 4; // keep at least this many tracks queued
const FILL_COOLDOWN_MS = 12_000; // don't refetch the graph more often than this
const MAX_APPEND = 8;
const MAX_QUEUE = 14; // cap the radio queue so it never grows unbounded
const PLAYED_CAP = 100; // remember only the last N plays — older ones can resurface

function dedupeByVideoId(list: TrackMeta[]): TrackMeta[] {
  const seen = new Set<string>();
  const out: TrackMeta[] = [];
  for (const t of list) {
    if (!t.videoId || seen.has(t.videoId)) continue;
    seen.add(t.videoId);
    out.push(t);
  }
  return out;
}

export function useMixQueue(): MixQueue {
  const [mode, setModeState] = useState<MixMode>("playlist");
  const [smartSort, setSmartSortState] = useState(false);
  const [augment, setAugmentState] = useState(true); // on by default — "super smart" blend
  const [items, setItems] = useState<TrackMeta[]>([]);
  const [current, setCurrentState] = useState<TrackMeta | null>(null);

  const played = useRef<Set<string>>(new Set());
  const filling = useRef(false);
  const lastFill = useRef(0);
  const lastSeed = useRef<string | null>(null); // signature of the seed SET the queue was last filled from
  const manualSeed = useRef<TrackMeta | null>(null); // a user-queued pick radio should follow until a deck changes
  const deckSeedSig = useRef<string | null>(null); // last DECK seed signature — manualSeed expires when it moves
  const lastDeckSeeds = useRef<TrackMeta[]>([]); // last deck seeds, so a manual add can refill without new deck context
  const playlistLoaded = useRef(false); // a fixed playlist is the source (don't auto-refresh it)
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const currentRef = useRef(current);
  currentRef.current = current;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const augmentRef = useRef(augment);
  augmentRef.current = augment;

  const setMode = useCallback((m: MixMode) => setModeState(m), []);
  const setAugment = useCallback((on: boolean) => setAugmentState(on), []);

  const setSmartSort = useCallback((on: boolean) => {
    setSmartSortState(on);
    if (on) setItems((cur) => smartSortChain(cur));
  }, []);

  // Patch known BPM/key onto queued/current tracks (best-effort) so the UI badges
  // and transition choices reflect real analysis instead of a neutral guess.
  const enrichAnalysis = useCallback(async (ids: string[]) => {
    const missing = ids.filter((id) => /^[\w-]{11}$/.test(id));
    if (!missing.length) return;
    const ana = await fetchAnalysisBatch(missing);
    if (!Object.keys(ana).length) return;
    const patch = (t: TrackMeta): TrackMeta => {
      const a = ana[t.videoId];
      if (!a) return t;
      return { ...t, bpm: t.bpm ?? a.bpm, key: t.key ?? a.key };
    };
    setItems((cur) => cur.map(patch));
    setCurrentState((c) => (c ? patch(c) : c));
  }, []);

  const loadTracks = useCallback(
    (tracks: TrackMeta[], opts?: { smartSort?: boolean; mode?: MixMode }) => {
      const sort = opts?.smartSort ?? false;
      played.current = new Set();
      lastFill.current = 0;
      lastSeed.current = null;
      manualSeed.current = null;
      deckSeedSig.current = null;
      playlistLoaded.current = tracks.length > 0; // a fixed playlist → don't auto-refresh it
      setSmartSortState(sort);
      if (opts?.mode) setModeState(opts.mode);
      setCurrentState(null);
      setItems(sort ? smartSortChain(tracks) : tracks.slice());
      // Fill in any missing key/BPM so smart-sort + badges are meaningful.
      void enrichAnalysis(tracks.filter((t) => t.bpm == null || t.key == null).map((t) => t.videoId));
    },
    [enrichAnalysis],
  );

  // Remember a play, but cap the set so an exhausted seed's radio can refill later
  // (an unbounded played-set is what froze the queue after the first sequence).
  const markPlayed = (id: string) => {
    played.current.add(id);
    while (played.current.size > PLAYED_CAP) {
      const oldest = played.current.values().next().value as string | undefined;
      if (oldest === undefined) break;
      played.current.delete(oldest);
    }
  };

  const setCurrent = useCallback((t: TrackMeta | null) => {
    if (t) markPlayed(t.videoId);
    setCurrentState(t);
  }, []);

  const getCurrent = useCallback((): TrackMeta | null => currentRef.current, []);

  const advance = useCallback((): TrackMeta | null => {
    const next = itemsRef.current[0] ?? null;
    if (!next) return null;
    markPlayed(next.videoId);
    setItems((cur) => cur.slice(1));
    setCurrentState(next);
    return next;
  }, []);

  const peekNext = useCallback((): TrackMeta | null => itemsRef.current[0] ?? null, []);

  const ensureNext = useCallback(async (seedsArg: TrackMeta | TrackMeta[] | null): Promise<TrackMeta | null> => {
    const deckSeeds = dedupeByVideoId(
      (Array.isArray(seedsArg) ? seedsArg : seedsArg ? [seedsArg] : []).filter((s): s is TrackMeta => !!s?.videoId),
    ).slice(0, 3);
    const deckSig = deckSeeds.map((s) => s.videoId).join(",");
    // "Dynamic" = radio mode, or augment when no fixed playlist is loaded → the queue
    // should follow whatever's playing now (not stay stuck on the first seed).
    const radioDynamic = modeRef.current === "radio" || (augmentRef.current && !playlistLoaded.current);
    // A manual queue-add (manualSeed) becomes the FRESHEST radio seed — suggestions follow
    // the user's pick — but only until a DECK changes, when radio reverts to the decks.
    // Detect the deck change by the deck-seed signature moving.
    if (radioDynamic && deckSeedSig.current !== null && deckSig !== deckSeedSig.current) {
      manualSeed.current = null;
    }
    deckSeedSig.current = deckSig;
    lastDeckSeeds.current = deckSeeds;
    // Active seeds: a manual pick dominates (prepended); otherwise just the decks.
    const seeds =
      radioDynamic && manualSeed.current
        ? dedupeByVideoId([manualSeed.current, ...deckSeeds]).slice(0, 3)
        : deckSeeds;
    if (!seeds.length) return itemsRef.current[0] ?? null;
    // Signature of the WHOLE active seed set (manual pick + both decks), not just seeds[0] —
    // so loading EITHER deck, OR a manual add, re-seeds. Keying off only the primary left
    // the queue stuck on the first seed whenever the change happened on deck B.
    const seedSig = (radioDynamic && manualSeed.current ? `m:${manualSeed.current.videoId}|` : "") + deckSig;
    const seedChanged = radioDynamic && seedSig !== lastSeed.current;
    const wantFill = modeRef.current === "radio" || augmentRef.current;
    const low = itemsRef.current.length < RADIO_MIN_AHEAD;
    if (wantFill && (low || seedChanged) && !filling.current) {
      const now = Date.now();
      // A seed change (a deck's track moved) bypasses the cooldown so suggestions adapt
      // to the new context immediately; otherwise honour the cooldown.
      if (seedChanged || now - lastFill.current >= FILL_COOLDOWN_MS) {
        filling.current = true;
        lastFill.current = now;
        lastSeed.current = seedSig;
        try {
          // Pull each loaded deck's provider radio, keeping rank (earlier = stronger).
          const lists = await Promise.all(
            seeds.map((s) =>
              fetchRecommendations(s.videoId, { provider: s.provider ?? null, isrc: s.isrc ?? null, title: s.title ?? null, artist: s.artist ?? null })
                .then((r) => r.map((t, i) => ({ t, rel: 1 - i / Math.max(1, r.length) })))
                .catch(() => [] as { t: TrackMeta; rel: number }[]),
            ),
          );
          // Aggregate relatedness: a track in MULTIPLE decks' radios (or high in one)
          // scores higher — it fits the whole current context.
          const rel = new Map<string, { track: TrackMeta; rel: number }>();
          for (const list of lists) {
            for (const { t, rel: r } of list) {
              const ex = rel.get(t.videoId);
              if (ex) ex.rel += r;
              else rel.set(t.videoId, { track: t, rel: r });
            }
          }
          // Song-level dedup: a candidate that's just another version of what's
          // playing/seeding/queued (different videoId, same song) is rejected.
          const coresSeen = new Set<string>();
          for (const s of seeds) coresSeen.add(songCore(s.title));
          if (currentRef.current) coresSeen.add(songCore(currentRef.current.title));
          for (const q of itemsRef.current) coresSeen.add(songCore(q.title));
          let cands = Array.from(rel.values()).filter(
            (c) =>
              !played.current.has(c.track.videoId) &&
              c.track.videoId !== currentRef.current?.videoId &&
              !seeds.some((s) => s.videoId === c.track.videoId) &&
              !itemsRef.current.some((q) => q.videoId === c.track.videoId) &&
              !coresSeen.has(songCore(c.track.title)), // not a re-version of a known song
          );
          if (cands.length) {
            // Enrich with known analysis so the harmonic refinement actually engages.
            const ana = await fetchAnalysisBatch(cands.map((c) => c.track.videoId));
            cands = cands.map((c) => {
              const a = ana[c.track.videoId];
              return a ? { ...c, track: { ...c.track, bpm: c.track.bpm ?? a.bpm, key: c.track.key ?? a.key } } : c;
            });
            // Final score = provider relatedness (backbone) refined by harmonic/tempo.
            const sorted = cands
              .map((c) => ({ track: c.track, final: 0.6 * Math.min(1, c.rel) + 0.4 * avgMixability(seeds, c.track) }))
              .sort((a, b) => b.final - a.final)
              .map((r) => r.track);
            // Keep only the best-ranked version of each distinct song.
            const ranked: TrackMeta[] = [];
            for (const t of sorted) {
              const core = songCore(t.title);
              if (core && coresSeen.has(core)) continue;
              if (core) coresSeen.add(core);
              ranked.push(t);
              if (ranked.length >= MAX_APPEND) break;
            }
            if (ranked.length) {
              setItems((cur) => {
                // On a seed change, REPLACE the stale tail (it was for the old track);
                // otherwise just top up. Dedupe + cap so the queue never bloats. A manually
                // queued pick stays PINNED at the front through a reseed — it's the seed the
                // fresh suggestions flow from, so it must not get swept away with the old tail.
                const pinId = manualSeed.current?.videoId;
                const pinned = pinId ? cur.filter((t) => t.videoId === pinId) : [];
                const merged = seedChanged ? [...pinned, ...ranked] : [...cur, ...ranked];
                const seen = new Set<string>();
                const out: TrackMeta[] = [];
                for (const t of merged) {
                  if (t.videoId && !seen.has(t.videoId)) {
                    seen.add(t.videoId);
                    out.push(t);
                  }
                }
                return out.slice(0, MAX_QUEUE);
              });
            }
          }
        } catch {
          /* best-effort — queue stays as-is */
        } finally {
          filling.current = false;
        }
      }
    }
    return itemsRef.current[0] ?? null;
  }, []);
  // Stable handle to ensureNext so a manual enqueue can trigger a refill without re-creating
  // callbacks or threading deck context through the UI (it reuses the last deck seeds).
  const ensureNextRef = useRef(ensureNext);
  ensureNextRef.current = ensureNext;

  const patchAnalysis = useCallback((videoId: string, a: { bpm?: number | null; key?: string | null; isrc?: string | null }) => {
    const apply = (t: TrackMeta): TrackMeta =>
      t.videoId === videoId ? { ...t, bpm: t.bpm ?? a.bpm ?? null, key: t.key ?? a.key ?? null, isrc: t.isrc ?? a.isrc ?? null } : t;
    setItems((cur) => cur.map(apply));
    setCurrentState((c) => (c ? apply(c) : c));
  }, []);

  const reseedRadio = useCallback(() => {
    // Only when dynamic — never nuke a curated playlist the user loaded.
    const dynamic = modeRef.current === "radio" || (augmentRef.current && !playlistLoaded.current);
    if (!dynamic) return;
    lastFill.current = 0;
    lastSeed.current = null; // force a fresh fill from the new seed on the next tick
    manualSeed.current = null; // a deliberate reseed (deck adopted) drops any manual pick
    setItems([]);
  }, []);

  const enqueue = useCallback((t: TrackMeta) => {
    setItems((cur) => (cur.some((x) => x.videoId === t.videoId) ? cur : [...cur, t]));
  }, []);

  const enqueueNext = useCallback((t: TrackMeta) => {
    setItems((cur) => [t, ...cur.filter((x) => x.videoId !== t.videoId)]);
    // In dynamic radio, the manual pick becomes the FRESHEST seed: pin it at the front and
    // refill the tail to flow from it (option A — suggestions follow your pick until a deck
    // changes). In playlist mode it's just an insertion, no reseed.
    const dynamic = modeRef.current === "radio" || (augmentRef.current && !playlistLoaded.current);
    if (dynamic) {
      manualSeed.current = t;
      lastSeed.current = null; // force the refill below to reseed from the new pick
      void ensureNextRef.current(lastDeckSeeds.current);
    }
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

  const moveById = useCallback((videoId: string, to: number) => {
    setItems((cur) => {
      const from = cur.findIndex((t) => t.videoId === videoId);
      if (from < 0) return cur; // already advanced/removed under us → drop the stale move
      const dest = Math.max(0, Math.min(to, cur.length - 1));
      if (from === dest) return cur;
      const next = cur.slice();
      const [moved] = next.splice(from, 1);
      next.splice(dest, 0, moved);
      return next;
    });
  }, []);

  const adopt = useCallback((tracks: TrackMeta[], cur: TrackMeta | null, m: MixMode) => {
    played.current = new Set();
    if (cur) played.current.add(cur.videoId);
    lastFill.current = 0;
    lastSeed.current = null;
    manualSeed.current = null;
    deckSeedSig.current = null;
    // Radio keeps topping itself up from the decks; only a real fixed playlist freezes
    // auto-refresh — otherwise the adopted radio queue would never refill again.
    playlistLoaded.current = m === "playlist" && tracks.length > 0;
    setModeState(m);
    setItems(tracks.slice());
    setCurrentState(cur);
  }, []);

  const clear = useCallback(() => {
    played.current = new Set();
    lastFill.current = 0;
    lastSeed.current = null;
    manualSeed.current = null;
    deckSeedSig.current = null;
    playlistLoaded.current = false;
    setItems([]);
    setCurrentState(null);
  }, []);

  return {
    mode,
    current,
    upcoming: items,
    smartSort,
    augment,
    setMode,
    setSmartSort,
    setAugment,
    loadTracks,
    setCurrent,
    getCurrent,
    advance,
    peekNext,
    ensureNext,
    patchAnalysis,
    reseedRadio,
    enqueue,
    enqueueNext,
    remove,
    reorder,
    moveById,
    adopt,
    clear,
  };
}
