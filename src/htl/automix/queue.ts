import { useCallback, useRef, useState } from "react";
import type { TrackMeta } from "../library/types";
import { fetchRecommendations } from "../media/recommend";
import { fetchAnalysisBatch } from "../media/api";
import { smartSortChain, songCore } from "./mixability";
import { type Candidate, isEligible, pickBest, radioSeeds, targetEnergy } from "./selector";
import type { EnergyArc, MixMode, RadioContext } from "./types";
import { trace } from "../debug/trace";

// The auto-mix queue: the ordered list of tracks the AutoMixer will play next.
//
// Fill sources:
//   - playlist: a fixed track list (optionally smart-sorted, optionally AUGMENTED
//     with provider radio when it runs low).
//   - radio: drawn from a standing POOL of candidates that the provider graph keeps stocked.
//
// The provider graph (YouTube/Tidal/YT-Music radio) is genre/vibe aware — it won't suggest
// Jeezy after Fishmans — so it is the BACKBONE of ranking; key/BPM/energy analysis refines it.
// The actual pick is `selector.ts`, which is where the weights and the reasoning live.
//
// ★ THE POOL, AND WHY THE QUEUE USED TO CHURN. The old fill fetched radio, ranked it, took eight,
// and — because a "seed change" was true every time a track started — REPLACED the entire upcoming
// tail every single song. Three network round-trips plus an analysis batch per song; the list you
// were reading rebuilt itself under you; and the AutoMixer's eager preload could be evicted
// mid-flight by a tail it no longer appeared in. It read as "the suggestions are random" even when
// each individual pick was defensible, because nothing ever stayed still long enough to be judged.
//
// Now a fill stocks a POOL of ~60 scored candidates, and the visible queue DRAWS from it, one
// track at a time, only when it runs short. Fills happen when the pool runs low — every several
// songs, not every song. The queue becomes append-mostly and stable; a candidate that sits in the
// pool keeps picking up analysis from the shared D1 cache on later fills, which is what finally
// makes the harmonic term carry real weight instead of cancelling out across the whole pool.

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
  /** Ensure the queue is topped up, given what the radio should sound like right now.
   *  Returns the next track. Passing null skips the radio entirely (playlist mode). */
  ensureNext: (ctx: RadioContext | null) => Promise<TrackMeta | null>;
  /** The energy shape the radio aims for. */
  arc: EnergyArc;
  setArc: (a: EnergyArc) => void;
  /** Patch known BPM/key/ISRC onto a queued/current track (from background precompute
   *  + fingerprint identification). */
  patchAnalysis: (videoId: string, a: { bpm?: number | null; key?: string | null; isrc?: string | null; energy?: number | null }) => void;
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
const MAX_QUEUE = 14; // cap the radio queue so it never grows unbounded
const PLAYED_CAP = 100; // remember only the last N plays — older ones can resurface
const SEED_HISTORY = 8; // recent plays kept for the artist-cooldown / repeat window
const POOL_MAX = 60; // standing candidates; a fill tops up to here
const POOL_LOW = 20; // refill when the pool drops below this — NOT every song
const POOL_ENRICH = 24; // per fill, ask D1 for analysis on up to this many un-analysed candidates

export function dedupeByVideoId(list: TrackMeta[]): TrackMeta[] {
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
  // ★ RADIO IS THE DEFAULT, and "playlist" is what you opt INTO by choosing one. The old default
  // was "playlist" with an empty list, which is a contradiction the UI could not express: AUTO with
  // nothing loaded sat on a fixed, empty, never-refilling source and simply had no next track. You
  // had to know to pick "Radio" from a dropdown to get the behaviour the feature is named after.
  const [mode, setModeState] = useState<MixMode>("radio");
  const [smartSort, setSmartSortState] = useState(false);
  const [augment, setAugmentState] = useState(true); // on by default — "super smart" blend
  const [items, setItems] = useState<TrackMeta[]>([]);
  const [current, setCurrentState] = useState<TrackMeta | null>(null);

  const [arc, setArcState] = useState<EnergyArc>("ride");

  const played = useRef<Set<string>>(new Set());
  // PLAY HISTORY, most-recent first. No longer the radio SEED (that is the anchor + current track
  // now — see selector.radioSeeds); this is the NEGATIVE signal: the artist-cooldown window and
  // the resurfacing penalty. A staged/preloaded deck track is never in here, so the queue still
  // cannot feed its own next pick back into its own reasoning.
  const history = useRef<TrackMeta[]>([]);
  // THE CANDIDATE POOL — standing, scored, drawn from one track at a time. See the header note.
  const poolRef = useRef<Candidate[]>([]);
  const filling = useRef(false);
  const lastFill = useRef(0);
  const lastSeed = useRef<string | null>(null); // signature of the seed SET the queue was last filled from
  const manualSeed = useRef<TrackMeta | null>(null); // a user-queued "play next" pick — the freshest seed until it plays
  const playlistLoaded = useRef(false); // a fixed playlist is the source (don't auto-refresh it)
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const currentRef = useRef(current);
  currentRef.current = current;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const augmentRef = useRef(augment);
  augmentRef.current = augment;
  const arcRef = useRef(arc);
  arcRef.current = arc;

  const setMode = useCallback((m: MixMode) => setModeState(m), []);
  const setAugment = useCallback((on: boolean) => setAugmentState(on), []);
  // Changing the arc changes what "fits" — drop the queued tail so the new shape takes effect on
  // the next track rather than after the four already-chosen ones have played out. The pool is
  // kept: those candidates are still valid, they just need re-scoring against the new target.
  const setArc = useCallback((a: EnergyArc) => {
    setArcState(a);
    if (modeRef.current === "radio" || augmentRef.current) {
      const keep = manualSeed.current ? [manualSeed.current] : [];
      setItems(keep);
    }
  }, []);

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
      return { ...t, bpm: t.bpm ?? a.bpm, key: t.key ?? a.key, energy: t.energy ?? a.energy ?? null };
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
      history.current = [];
      poolRef.current = []; // a new source → the old candidates were for a different set
      playlistLoaded.current = tracks.length > 0; // a fixed playlist → don't auto-refresh it
      setSmartSortState(sort);
      // An EMPTY load is not a playlist, whatever the caller asked for — a playlist whose tracks
      // all failed to resolve, or a cleared queue, must fall back to radio rather than strand AUTO
      // on a source that can never produce a track.
      if (opts?.mode) setModeState(tracks.length === 0 ? "radio" : opts.mode);
      setCurrentState(null);
      setItems(sort ? smartSortChain(tracks) : tracks.slice());
      // Fill in any missing key/BPM so smart-sort + badges are meaningful.
      void enrichAnalysis(tracks.filter((t) => t.bpm == null || t.key == null).map((t) => t.videoId));
    },
    [enrichAnalysis],
  );

  // Remember a play: it joins the dedup set (capped so an exhausted seed can refill later — an
  // unbounded played-set is what froze the queue after the first sequence) AND becomes the freshest
  // RADIO SEED at the head of `history`. A user's "play next" pick is consumed once anything plays,
  // so the seed hands back to history.
  const markPlayed = (track: TrackMeta) => {
    const id = track.videoId;
    if (!id) return;
    played.current.add(id);
    while (played.current.size > PLAYED_CAP) {
      const oldest = played.current.values().next().value as string | undefined;
      if (oldest === undefined) break;
      played.current.delete(oldest);
    }
    history.current = [track, ...history.current.filter((t) => t.videoId !== id)].slice(0, SEED_HISTORY);
    manualSeed.current = null;
  };

  const setCurrent = useCallback((t: TrackMeta | null) => {
    if (t) markPlayed(t);
    setCurrentState(t);
  }, []);

  const getCurrent = useCallback((): TrackMeta | null => currentRef.current, []);

  const advance = useCallback((): TrackMeta | null => {
    const next = itemsRef.current[0] ?? null;
    if (!next) return null;
    markPlayed(next);
    setItems((cur) => cur.slice(1));
    setCurrentState(next);
    return next;
  }, []);

  const peekNext = useCallback((): TrackMeta | null => itemsRef.current[0] ?? null, []);

  // Merge freshly-fetched radio results into the standing pool. Relatedness is taken as a MAX
  // across seeds, never a sum: summing rewarded tracks that appear in several seeds' radios, which
  // sounds like "it fits the whole context" and is in practice "it is the popular one everyone
  // links to" — the mechanism that made the radio circle the same dozen tracks.
  const mergePool = (lists: { track: TrackMeta; rel: number; from: string }[][]): void => {
    const now = Date.now();
    const byId = new Map<string, Candidate>();
    for (const c of poolRef.current) byId.set(c.track.videoId, c);
    for (const list of lists) {
      for (const { track, rel, from } of list) {
        const ex = byId.get(track.videoId);
        if (ex) {
          ex.rel = Math.max(ex.rel, rel);
          // Keep whichever copy carries more metadata (a later fill may arrive analysed).
          if (ex.track.bpm == null && track.bpm != null) ex.track = { ...ex.track, bpm: track.bpm };
          if (ex.track.key == null && track.key != null) ex.track = { ...ex.track, key: track.key };
          if (ex.track.energy == null && track.energy != null) ex.track = { ...ex.track, energy: track.energy };
        } else {
          byId.set(track.videoId, { track, rel, from, at: now });
        }
      }
    }
    // Over capacity → keep the strongest provider signals. Ties keep the OLDER entry, which has
    // had the most chances to pick up analysis.
    let out = Array.from(byId.values());
    if (out.length > POOL_MAX) {
      out = out.sort((a, b) => b.rel - a.rel || a.at - b.at).slice(0, POOL_MAX);
    }
    poolRef.current = out;
  };

  // Top the pool up with analysis the shared D1 cache already knows. Runs on every fill, over
  // candidates still missing key/BPM — the cache grows as other sessions analyse tracks, so a
  // candidate that sat in the pool unanalysed can become a fully-scoreable one later for free.
  const enrichPool = async (): Promise<void> => {
    const missing = poolRef.current
      .filter((c) => (c.track.bpm == null || c.track.key == null || c.track.energy == null) && /^[\w-]{11}$/.test(c.track.videoId))
      .slice(0, POOL_ENRICH)
      .map((c) => c.track.videoId);
    if (!missing.length) return;
    const ana = await fetchAnalysisBatch(missing);
    if (!Object.keys(ana).length) return;
    for (const c of poolRef.current) {
      const a = ana[c.track.videoId];
      if (!a) continue;
      c.track = { ...c.track, bpm: c.track.bpm ?? a.bpm, key: c.track.key ?? a.key, energy: c.track.energy ?? a.energy ?? null };
    }
  };

  // Draw from the pool into the visible queue until it is RADIO_MIN_AHEAD deep. Each draw is
  // scored against the track it would actually follow — the tail of the queue, not the currently
  // playing track — so the queue is a CHAIN, and the artist/repeat window is measured backwards
  // from the insertion point rather than from now.
  const drawFromPool = (ctx: RadioContext): number => {
    let drawn = 0;
    for (let guard = 0; guard < MAX_QUEUE; guard++) {
      const items = itemsRef.current;
      if (items.length >= RADIO_MIN_AHEAD || items.length >= MAX_QUEUE) break;

      const bans = {
        played: played.current,
        ids: new Set<string>([...items.map((t) => t.videoId), currentRef.current?.videoId ?? ""]),
        cores: new Set<string>(
          [...items, currentRef.current, ctx.anchor].filter((t): t is TrackMeta => !!t).map((t) => songCore(t.title)),
        ),
      };
      const eligible = poolRef.current.filter((c) => isEligible(c.track, bans));
      if (!eligible.length) break;

      // Everything that will play between now and the slot being filled, nearest first.
      const nearby: TrackMeta[] = [
        ...items.slice().reverse(),
        ...(currentRef.current ? [currentRef.current] : []),
        ...history.current,
      ];
      const prev = items.length ? items[items.length - 1] : currentRef.current;
      const target = targetEnergy(ctx.arc, prev?.energy ?? 0.5, ctx.played);
      const best = pickBest(eligible, prev, {
        nearby,
        playedRecently: Array.from(played.current).reverse(),
        target,
      });
      if (!best) break;

      poolRef.current = poolRef.current.filter((c) => c.track.videoId !== best.candidate.track.videoId);
      const t = best.candidate.track;
      setItems((cur) => (cur.some((x) => x.videoId === t.videoId) ? cur : [...cur, t]));
      itemsRef.current = [...itemsRef.current, t]; // keep the loop's view current within this pass
      drawn++;
      trace("automix.pick", {
        id: t.videoId,
        title: t.title.slice(0, 48),
        artist: t.artist.slice(0, 24),
        after: prev?.videoId ?? null,
        pool: poolRef.current.length,
        target: Math.round(target * 100) / 100,
        ...Object.fromEntries(Object.entries(best.parts).map(([k, v]) => [k, Math.round(v * 1000) / 1000])),
      });
    }
    return drawn;
  };

  const ensureNext = useCallback(async (ctx?: RadioContext | null): Promise<TrackMeta | null> => {
    const radioDynamic = modeRef.current === "radio" || (augmentRef.current && !playlistLoaded.current);
    if (!radioDynamic || !ctx) return itemsRef.current[0] ?? null; // a fixed playlist plays itself

    // TWO STABLE SEEDS, not a sliding window over the last three plays: the vibe anchor (decaying)
    // and what is playing. See selector.radioSeeds for why the old scheme amplified its own
    // repetition. A user's explicit "play next" pick outranks both until it plays.
    const effCtx: RadioContext = { ...ctx, arc: ctx.arc ?? arcRef.current };
    const seeds = radioSeeds(effCtx, manualSeed.current);
    if (!seeds.length) return itemsRef.current[0] ?? null;

    // The pool is refilled when it runs LOW or when the vibe genuinely moved — not once a song.
    const seedSig = seeds.map((s) => `${s.track.videoId}:${s.weight.toFixed(2)}`).join(",");
    const seedChanged = seedSig !== lastSeed.current;
    const poolLow = poolRef.current.length < POOL_LOW;
    const now = Date.now();
    if ((poolLow || seedChanged) && !filling.current && (seedChanged || now - lastFill.current >= FILL_COOLDOWN_MS)) {
      filling.current = true;
      lastFill.current = now;
      lastSeed.current = seedSig;
      try {
        const lists = await Promise.all(
          seeds.map(({ track: s, weight }) =>
            fetchRecommendations(s.videoId, {
              provider: s.provider ?? null,
              isrc: s.isrc ?? null,
              title: s.title ?? null,
              artist: s.artist ?? null,
              limit: 40, // breadth: the pool wants candidates, and one request is one round trip
            })
              // Rank within a seed's own list → relatedness, then scaled by how much that seed
              // still counts (the anchor's vote fades as the set moves on).
              .then((r) => r.map((t, i) => ({ track: t, rel: (1 - i / Math.max(1, r.length)) * weight, from: s.videoId })))
              .catch(() => [] as { track: TrackMeta; rel: number; from: string }[]),
          ),
        );
        mergePool(lists);
        await enrichPool();
        trace("automix.fill", {
          seeds: seeds.map((s) => `${s.track.videoId}@${s.weight.toFixed(2)}`).join(","),
          fetched: lists.reduce((n, l) => n + l.length, 0),
          pool: poolRef.current.length,
          analysed: poolRef.current.filter((c) => c.track.bpm != null && c.track.key != null).length,
          anchorAge: effCtx.anchorAge,
        });
      } catch {
        /* best-effort — the pool keeps whatever it had */
      } finally {
        filling.current = false;
      }
    }

    drawFromPool(effCtx);
    return itemsRef.current[0] ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- all reads go through refs; the
    // helpers above close over those same refs, so this callback is genuinely stable.
  }, []);
  // Stable handle to ensureNext so a manual enqueue can trigger a refill without re-creating
  // callbacks or threading deck context through the UI (it reuses the last deck seeds).
  const ensureNextRef = useRef(ensureNext);
  ensureNextRef.current = ensureNext;

  const patchAnalysis = useCallback(
    (videoId: string, a: { bpm?: number | null; key?: string | null; isrc?: string | null; energy?: number | null }) => {
      const apply = (t: TrackMeta): TrackMeta =>
        t.videoId === videoId
          ? {
              ...t,
              bpm: t.bpm ?? a.bpm ?? null,
              key: t.key ?? a.key ?? null,
              isrc: t.isrc ?? a.isrc ?? null,
              energy: t.energy ?? a.energy ?? null,
            }
          : t;
      setItems((cur) => cur.map(apply));
      setCurrentState((c) => (c ? apply(c) : c));
      // The pool too: a candidate that gets analysed while it waits becomes fully scoreable, which
      // is the whole reason the pool is a standing structure rather than a per-song fetch.
      for (const c of poolRef.current) if (c.track.videoId === videoId) c.track = apply(c.track);
    },
    [],
  );

  const reseedRadio = useCallback(() => {
    // Only when dynamic — never nuke a curated playlist the user loaded.
    const dynamic = modeRef.current === "radio" || (augmentRef.current && !playlistLoaded.current);
    if (!dynamic) return;
    lastFill.current = 0;
    lastSeed.current = null; // force a fresh fill from the new seed on the next tick
    // The POOL survives a reseed on purpose. It is expensive to rebuild, and dropping it left a
    // dry spell every time the user changed records. Candidates from the new seed merge in and,
    // being scored against the new context, outrank the stale ones on their own merits; anything
    // that never wins is aged out by POOL_MAX.
    // Drop the manual pick as the radio SEED (suggestions re-anchor to the new deck), but KEEP
    // the user's explicitly queued "play next" track — nuking the whole queue on a deck change
    // silently lost a track the user had deliberately lined up.
    const keep = manualSeed.current ? [manualSeed.current] : [];
    manualSeed.current = null;
    setItems(keep);
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
      void ensureNextRef.current();
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
    history.current = cur ? [cur] : []; // the cooldown window restarts from the now-playing track
    poolRef.current = []; // the previous anchor's pool did not come across the handover
    lastFill.current = 0;
    lastSeed.current = null;
    manualSeed.current = null;
    // Radio keeps topping itself up from the decks; only a real fixed playlist freezes
    // auto-refresh — otherwise the adopted radio queue would never refill again.
    playlistLoaded.current = m === "playlist" && tracks.length > 0;
    setModeState(m);
    setItems(tracks.slice());
    setCurrentState(cur);
  }, []);

  const clear = useCallback(() => {
    setModeState("radio"); // clearing removes the playlist, so the source returns to the default
    played.current = new Set();
    history.current = [];
    poolRef.current = [];
    lastFill.current = 0;
    lastSeed.current = null;
    manualSeed.current = null;
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
    arc,
    setArc,
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
