import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { AudioEngine, DeckId, SampleMode } from "@htl";
import { decodeAudio } from "@htl/audio";
import {
  MAX_SAMPLE_BYTES,
  MAX_SAMPLE_MS,
  deleteSample,
  listSamples,
  sampleAudioUrl,
  uploadSample,
  type SampleDto,
} from "@htl/media";
import type { Me } from "@htl/account";

// The sampler's state engine. The 28 pads split into one GLOBAL bank + two per-deck
// REGION banks, addressed by a flat index:
//   0-11  → GLOBAL (master route): uploaded files, account-stored (the strip).
//   12-19 → deck A region (A channel): "play X→Y" of deck A's track (a deck pad-mode).
//   20-27 → deck B region (B channel): deck B's track.
// Region pads are positions only (per-track, local); global pads are files (R2/D1).

export const GLOBAL_COUNT = 12;
export const DECK_REGION_COUNT = 8;
export const PAD_COUNT = GLOBAL_COUNT + DECK_REGION_COUNT * 2; // 28
export const GLOBAL_PADS = Array.from({ length: GLOBAL_COUNT }, (_, i) => `g${i}`);
const REGION_KEY = "htl:samplerRegions"; // { [videoId]: (RegionDesc|null)[8] }
const GLOBAL_META_KEY = "htl:samplerGlobalMeta"; // { g0:{mode,gain}, ... } (server holds the file+name)

export const routeOf = (i: number): "A" | "master" | "B" =>
  i < GLOBAL_COUNT ? "master" : i < GLOBAL_COUNT + DECK_REGION_COUNT ? "A" : "B";
const regionDeck = (i: number): DeckId => (i < GLOBAL_COUNT + DECK_REGION_COUNT ? "A" : "B");
const regionSlot = (i: number): number =>
  i < GLOBAL_COUNT + DECK_REGION_COUNT ? i - GLOBAL_COUNT : i - GLOBAL_COUNT - DECK_REGION_COUNT; // 0..7
const globalSlot = (i: number): number => i; // 0..11
/** First pad index of a deck's 8-pad region bank (so the deck's SAMPLER pad-mode slices it). */
export const deckPadBase = (deckId: DeckId): number =>
  deckId === "A" ? GLOBAL_COUNT : GLOBAL_COUNT + DECK_REGION_COUNT; // 12 | 20

interface RegionDesc {
  start: number;
  end: number;
  name: string;
  mode: SampleMode;
  gain: number;
}
type RegionStore = Record<string, (RegionDesc | null)[]>;
interface GlobalPad {
  sampleId?: string; // server id (absent until uploaded)
  name: string;
  mode: SampleMode;
  gain: number;
  uploading?: boolean;
  ready: boolean; // decoded buffer present (triggerable)
}
type GlobalMeta = Record<string, { mode: SampleMode; gain: number }>;

export interface SamplerPad {
  index: number;
  route: "A" | "master" | "B";
  kind: "empty" | "region" | "file";
  name: string;
  mode: SampleMode;
  gain: number;
  start?: number;
  end?: number;
  playing: boolean;
  uploading?: boolean;
  ready: boolean; // can be triggered right now
  hasTrack?: boolean; // region pads: a track is loaded on that deck (so capture is possible)
}

function loadJson<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
function saveJson(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}

const emptyRegionArr = (): (RegionDesc | null)[] => Array(DECK_REGION_COUNT).fill(null);
const emptyGlobals = (meta: GlobalMeta): GlobalPad[] =>
  GLOBAL_PADS.map((g) => ({ name: "", mode: meta[g]?.mode ?? "oneshot", gain: meta[g]?.gain ?? 1, ready: false }));

export function useSampler(engine: AudioEngine, loaded: { A: string | null; B: string | null }, me: Me | null) {
  const [regions, setRegions] = useState<RegionStore>(() => loadJson<RegionStore>(REGION_KEY, {}));
  const globalMeta = useRef<GlobalMeta>(loadJson<GlobalMeta>(GLOBAL_META_KEY, {}));
  const [globals, setGlobals] = useState<GlobalPad[]>(() => emptyGlobals(globalMeta.current));
  const fileBuffers = useRef<(AudioBuffer | null)[]>(Array(GLOBAL_COUNT).fill(null)); // decoded global clips
  const [error, setError] = useState<string | null>(null);
  const [playTick, bumpPlaying] = useReducer((n: number) => n + 1, 0); // re-render when voices start/stop

  // Light a pad while its voice sounds.
  useEffect(() => {
    engine.sampler.onChange = () => bumpPlaying();
    return () => {
      engine.sampler.onChange = null;
    };
  }, [engine]);

  const persistRegions = useCallback((next: RegionStore) => {
    setRegions(next);
    saveJson(REGION_KEY, next);
  }, []);
  const persistGlobalMeta = useCallback(() => saveJson(GLOBAL_META_KEY, globalMeta.current), []);

  // Restore the account's global samples on sign-in: list → fetch bytes → decode → assign.
  useEffect(() => {
    if (!me?.user) {
      // signed out: drop the global clips (keep local mode/gain prefs)
      fileBuffers.current = Array(GLOBAL_COUNT).fill(null);
      setGlobals(emptyGlobals(globalMeta.current));
      engine.sampler.stopAll();
      return;
    }
    let cancelled = false;
    void (async () => {
      let dtos: SampleDto[] = [];
      try {
        dtos = await listSamples();
      } catch {
        return;
      }
      for (const s of dtos) {
        const gi = GLOBAL_PADS.indexOf(s.pad);
        if (gi < 0) continue;
        try {
          const res = await fetch(sampleAudioUrl(s.id), { credentials: "same-origin" });
          if (!res.ok) continue;
          const buf = await decodeAudio(engine.ctx, await res.arrayBuffer());
          if (cancelled) return;
          fileBuffers.current[gi] = buf;
          setGlobals((prev) => {
            const next = [...prev];
            next[gi] = { ...next[gi], sampleId: s.id, name: s.name, ready: true, uploading: false };
            return next;
          });
        } catch {
          /* skip a clip that won't decode */
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.user?.id, engine]);

  // The 28 pads, derived from regions (per loaded track) + globals + live playing state.
  const pads = useMemo<SamplerPad[]>(() => {
    const out: SamplerPad[] = [];
    for (let i = 0; i < PAD_COUNT; i++) {
      const route = routeOf(i);
      const playing = engine.sampler.isPlaying(i);
      if (route === "master") {
        const g = globals[globalSlot(i)];
        const has = !!(g.sampleId || g.uploading || g.ready);
        out.push({
          index: i,
          route,
          kind: has ? "file" : "empty",
          name: g.name,
          mode: g.mode,
          gain: g.gain,
          playing,
          uploading: g.uploading,
          ready: g.ready,
        });
      } else {
        const vid = regionDeck(i) === "A" ? loaded.A : loaded.B;
        const r = vid ? regions[vid]?.[regionSlot(i)] ?? null : null;
        out.push({
          index: i,
          route,
          kind: r ? "region" : "empty",
          name: r?.name ?? "",
          mode: r?.mode ?? "oneshot",
          gain: r?.gain ?? 1,
          start: r?.start,
          end: r?.end,
          playing,
          ready: !!r,
          hasTrack: !!vid,
        });
      }
    }
    return out;
    // playTick forces this to recompute when a voice starts/stops (isPlaying is read fresh).
  }, [regions, globals, loaded.A, loaded.B, engine, playTick]);

  // ---- actions ----

  const trigger = useCallback(
    (i: number) => {
      engine.resume();
      const route = routeOf(i);
      if (route === "master") {
        const buf = fileBuffers.current[globalSlot(i)];
        const g = globals[globalSlot(i)];
        if (!buf) return;
        engine.sampler.play(i, { buffer: buf, route: "master", mode: g.mode, gain: g.gain });
      } else {
        const id = regionDeck(i);
        const d = engine.deck(id);
        const vid = id === "A" ? loaded.A : loaded.B;
        const r = vid ? regions[vid]?.[regionSlot(i)] : null;
        if (!r || !d.buffer) return;
        engine.sampler.play(i, { buffer: d.buffer, offset: r.start, duration: r.end - r.start, route, mode: r.mode, gain: r.gain });
      }
    },
    [engine, globals, regions, loaded.A, loaded.B],
  );

  const release = useCallback(
    (i: number) => {
      const pad = pads[i];
      if (pad?.mode === "gate") engine.sampler.release(i);
    },
    [engine, pads],
  );

  // Capture a region from the deck: its active loop if set, else one bar from the playhead.
  const assignRegion = useCallback(
    (i: number) => {
      const id = regionDeck(i);
      const d = engine.deck(id);
      const vid = id === "A" ? loaded.A : loaded.B;
      if (!vid || !d.buffer) return;
      let start: number, end: number;
      if (d.loop) {
        start = d.loop.start;
        end = d.loop.end;
      } else {
        start = d.position();
        const beat = d.beatgrid?.interval ?? 0.5;
        end = Math.min(d.duration, start + beat * 4);
      }
      if (end - start < 0.05) return;
      const slot = regionSlot(i);
      const next: RegionStore = { ...regions };
      const arr = (next[vid] ? [...next[vid]] : emptyRegionArr()) as (RegionDesc | null)[];
      arr[slot] = { start, end, name: `${id}${slot + 1}`, mode: arr[slot]?.mode ?? "oneshot", gain: arr[slot]?.gain ?? 1 };
      next[vid] = arr;
      persistRegions(next);
    },
    [engine, loaded.A, loaded.B, regions, persistRegions],
  );

  // Assign an uploaded file to a global pad: validate → decode (for instant play) → upload.
  const assignFile = useCallback(
    async (i: number, file: File) => {
      const gi = globalSlot(i);
      setError(null);
      if (file.size > MAX_SAMPLE_BYTES) {
        setError(`“${file.name}” is too big (max ${Math.round(MAX_SAMPLE_BYTES / 1024 / 1024)} MB).`);
        return;
      }
      const raw = await file.arrayBuffer();
      let buf: AudioBuffer;
      try {
        buf = await decodeAudio(engine.ctx, raw.slice(0)); // decode a COPY (decodeAudioData detaches it)
      } catch {
        setError(`Couldn't decode “${file.name}”.`);
        return;
      }
      if (buf.duration * 1000 > MAX_SAMPLE_MS + 50) {
        setError(`“${file.name}” is ${buf.duration.toFixed(1)}s — samples must be ≤ ${MAX_SAMPLE_MS / 1000}s.`);
        return;
      }
      const name = file.name.replace(/\.[^.]+$/, "").slice(0, 60) || "Sample";
      fileBuffers.current[gi] = buf;
      setGlobals((prev) => {
        const next = [...prev];
        next[gi] = { ...next[gi], name, ready: true, uploading: !!me?.user };
        return next;
      });
      if (!me?.user) {
        setError("Sign in to save samples to your account — this one is loaded for now but won't persist.");
        return;
      }
      try {
        const dto = await uploadSample(GLOBAL_PADS[gi], name, buf.duration * 1000, raw, file.type || "audio/wav");
        setGlobals((prev) => {
          const next = [...prev];
          next[gi] = { ...next[gi], sampleId: dto.id, uploading: false };
          return next;
        });
      } catch (e) {
        setGlobals((prev) => {
          const next = [...prev];
          next[gi] = { ...next[gi], uploading: false };
          return next;
        });
        setError(`Upload failed: ${(e as Error).message}`);
      }
    },
    [engine, me?.user],
  );

  const clearPad = useCallback(
    (i: number) => {
      engine.sampler.stop(i);
      if (routeOf(i) === "master") {
        const gi = globalSlot(i);
        const g = globals[gi];
        fileBuffers.current[gi] = null;
        if (g.sampleId) void deleteSample(g.sampleId);
        setGlobals((prev) => {
          const next = [...prev];
          next[gi] = { name: "", mode: globalMeta.current[GLOBAL_PADS[gi]]?.mode ?? "oneshot", gain: globalMeta.current[GLOBAL_PADS[gi]]?.gain ?? 1, ready: false };
          return next;
        });
      } else {
        const vid = regionDeck(i) === "A" ? loaded.A : loaded.B;
        if (!vid || !regions[vid]) return;
        const next: RegionStore = { ...regions };
        const arr = [...next[vid]];
        arr[regionSlot(i)] = null;
        if (arr.every((x) => x == null)) delete next[vid];
        else next[vid] = arr;
        persistRegions(next);
      }
    },
    [engine, globals, regions, loaded.A, loaded.B, persistRegions],
  );

  const setMode = useCallback(
    (i: number, mode: SampleMode) => {
      if (routeOf(i) === "master") {
        const gi = globalSlot(i);
        globalMeta.current[GLOBAL_PADS[gi]] = { mode, gain: globals[gi].gain };
        persistGlobalMeta();
        setGlobals((prev) => {
          const next = [...prev];
          next[gi] = { ...next[gi], mode };
          return next;
        });
      } else {
        const vid = regionDeck(i) === "A" ? loaded.A : loaded.B;
        if (!vid || !regions[vid]?.[regionSlot(i)]) return;
        const next: RegionStore = { ...regions };
        const arr = [...next[vid]];
        arr[regionSlot(i)] = { ...(arr[regionSlot(i)] as RegionDesc), mode };
        next[vid] = arr;
        persistRegions(next);
      }
    },
    [globals, regions, loaded.A, loaded.B, persistRegions, persistGlobalMeta],
  );

  const setGain = useCallback(
    (i: number, gain: number) => {
      engine.sampler.setGain(i, gain); // live-adjust if sounding
      if (routeOf(i) === "master") {
        const gi = globalSlot(i);
        globalMeta.current[GLOBAL_PADS[gi]] = { mode: globals[gi].mode, gain };
        persistGlobalMeta();
        setGlobals((prev) => {
          const next = [...prev];
          next[gi] = { ...next[gi], gain };
          return next;
        });
      } else {
        const vid = regionDeck(i) === "A" ? loaded.A : loaded.B;
        if (!vid || !regions[vid]?.[regionSlot(i)]) return;
        const next: RegionStore = { ...regions };
        const arr = [...next[vid]];
        arr[regionSlot(i)] = { ...(arr[regionSlot(i)] as RegionDesc), gain };
        next[vid] = arr;
        persistRegions(next);
      }
    },
    [engine, globals, regions, loaded.A, loaded.B, persistRegions, persistGlobalMeta],
  );

  return { pads, error, clearError: () => setError(null), trigger, release, assignRegion, assignFile, clearPad, setMode, setGain };
}

export type SamplerApi = ReturnType<typeof useSampler>;
