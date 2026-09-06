// useStemPipeline — the deriveStems cluster, lifted out of App.tsx so a stems-agent can own this
// file instead of contending on App.tsx. PURE RELOCATION: the two function bodies below are
// verbatim from App; the App spine arrives via `deps` (destructured to the original names so the
// closures are unchanged). The type-only `../App` import is erased at build (no runtime cycle).
// See htl-refactor-monoliths.
import { useCallback, useRef } from "react";
import type { MutableRefObject } from "react";
import {
  loadStems,
  loadStemsPackedInt16,
  loadStemsLocal,
  getStemModel,
  modelSupport,
  isMobileDevice,
  fetchStemManifest,
  armGpu,
  disarmGpu,
  stemTrace,
  dropCachedBuffer,
  decodeAudio,
  fetchYouTubeAudio,
  getAudio,
  putAudio,
  type Stems,
  type StemModel,
} from "@htl";
import type { DeckId } from "@htl/audio";
import type { StemStatus, StemPhase } from "../App";
import { whenIdle } from "../util/idle";
import { useSpine } from "./spine";

// Stem names in the fixed deck order. Shared with App (snapshot apply) + the session stem-sync.
export const STEM_KEYS = ["drums", "bass", "vocals", "other"] as const;
// Neural models to auto-promote a DSP deck to. ONE engine now — demucs (its manifest
// probe transparently falls back to the pre-rename "htdemucs-onnx" cache namespace).
export const PROMOTE_ORDER = ["htdemucs"];
// Short engine label for the deck chip: any demucs variant → "Demucs".
export function stemSrcLabel(modelId: string): string {
  if (modelId.startsWith("htdemucs")) return "Demucs";
  return getStemModel(modelId).label;
}
// Cross-device AGGREGATE stem budget (mobile), the iOS memory SEATBELT. Byte-accurate: a resident
// int16 stem set costs 4 stems × 2ch × 2 bytes = 16 B/sample (~46 MB/min @48k), so a single 10-min
// set ≈ 460 MB and TWO ≈ 920 MB — over the ~1.3 GB WebKit Gigacage on older iPhones, which is the
// confirmed 2-deadmau5 crash. The old proxy gated on a 16-min SECONDS SUM (bytes-blind: ignored
// stem count / rate / channels) and let 2×8-min sit right at the boundary → 736 MB → jetsam. This
// caps RESIDENT stem bytes across both decks below the observed crash point; a single long deck
// (≤~13 min) always fits, two decks share the budget, and an over-budget load DECLINES to the plain
// mix instead of crashing. Tunable pending the on-device probe (engine/test/iphone-mem-probe.html).
const MOBILE_STEM_BYTE_BUDGET = 600 * 1024 * 1024; // 600 MB resident, combined across decks
const STEM_SET_BYTES_PER_SAMPLE = 16; // 4 stems × 2 channels × 2 bytes (int16)
// Serializes mobile derive passes so two decks never build float32 sets concurrently (iOS OOM).
let mobileDeriveChain: Promise<unknown> = Promise.resolve();

// The App-owned state the stem pipeline reaches into — stable refs / callbacks. `engine`/`refresh`
// come from the spine context, not here.
export interface StemPipelineDeps {
  setStatusFor: (id: DeckId, st: StemStatus | null) => void;
  requestStemsFromHost: (id: DeckId, model: StemModel) => boolean;
  stemModelRef: MutableRefObject<string>;
  mobileStemsRef: MutableRefObject<boolean>;
  autoEnabledRef: MutableRefObject<boolean>;
  autoEnhanceRef: MutableRefObject<boolean>;
  deriveGuard: MutableRefObject<Record<DeckId, string>>;
  stemLoadedKey: MutableRefObject<Record<DeckId, string>>;
  stemJobs: MutableRefObject<Map<string, Promise<Stems>>>;
  snapFollowRef: MutableRefObject<boolean>;
  lastSnapshotRef: MutableRefObject<{ decks?: Partial<Record<DeckId, { hasStems?: boolean } | undefined>> } | null>;
}

export function useStemPipeline(deps: StemPipelineDeps) {
  const { engine, refresh } = useSpine();
  const {
    setStatusFor,
    requestStemsFromHost,
    stemModelRef,
    mobileStemsRef,
    autoEnabledRef,
    autoEnhanceRef,
    deriveGuard,
    stemLoadedKey,
    stemJobs,
    snapFollowRef,
    lastSnapshotRef,
  } = deps;

  const promoteCachedStems = useCallback(
    async (id: DeckId, videoId: string, mix: AudioBuffer, stale?: () => boolean) => {
      // 1. Local disk first (instant, offline): the best neural stems we already have.
      for (const mid of PROMOTE_ORDER) {
        const local = await loadStemsLocal(engine.ctx, videoId, mid);
        if (stale?.()) return false;
        if (local) {
          engine.deck(id).setStems(local, true, videoId); // neural → per-stem lanes
          // Stamp the dedup key with the PROMOTED model so selecting that model later
          // sees "already separated" (deriveStems' hasStems guard) instead of re-running
          // a separation over the stems we just promoted. (The bug: promote never set this.)
          stemLoadedKey.current[id] = `${videoId}:${mid}`;
          refresh();
          setStatusFor(id, {
            phase: "promoted",
            src: stemSrcLabel(mid),
            detail: `Auto-enhanced with ${getStemModel(mid).label} (cached on disk) — your stem setting stays DSP.`,
          });
          return true;
        }
      }
      // 2. Shared R2 cache: probe candidates best-first; first complete one wins.
      for (const mid of PROMOTE_ORDER) {
        const man = await fetchStemManifest(videoId, mid).catch(() => null);
        if (stale?.()) return false;
        if (!man?.complete) continue;
        const m = getStemModel(mid);
        const src = stemSrcLabel(mid);
        stemTrace(`promote ${id}:download`, mid); // crash here ⇒ downloading/decoding a cached neural set OOMs
        setStatusFor(id, { phase: "downloading", src, detail: `Enhanced stems found (${m.label}) — downloading…` });
        try {
          const key = `${videoId}:${mid}`;
          let job = stemJobs.current.get(key);
          if (!job) {
            job = loadStems(engine.ctx, videoId, mix, m, (pct) => {
              const p = Math.round(pct * 100);
              setStatusFor(id, { phase: "downloading", src, pct: p, detail: `Enhancing with ${m.label}… ${p}%` });
            });
            stemJobs.current.set(key, job);
            void job.finally(() => {
              if (stemJobs.current.get(key) === job) stemJobs.current.delete(key);
            });
          }
          const neural = await job;
          if (stale?.()) return false;
          // loadStems throws (not a DSP fallback) when the set can't be produced → the catch below
          // returns false, nothing to promote. Reaching here means a real neural set downloaded.
          engine.deck(id).setStems(neural, true, videoId); // neural → per-stem lanes
          stemLoadedKey.current[id] = `${videoId}:${mid}`; // promoted set → don't re-separate it
          refresh();
          setStatusFor(id, {
            phase: "promoted",
            src,
            detail: `Auto-enhanced with ${m.label} (from the shared cache) — your stem setting stays DSP.`,
          });
          return true; // applied a cached neural set (one set — safe on mobile)
        } catch {
          /* promotion is best-effort — caller falls back to the DSP split */
          return false;
        }
      }
      // Nothing cached anywhere → caller shows the DSP split.
      return false;
    },
    [engine, refresh, setStatusFor],
  );

  // Resolve a deck's stems: light the buttons instantly with the DSP split, then —
  // if a neural model is selected — separate (R2 cache → on-device ONNX) in the
  // background and swap the cleaner stems in. Both sum to the mix, so it's seamless.
  // `stale()` (when given) drops results if the deck moved on to another track.
  const deriveStems = useCallback(
    async (id: DeckId, videoId: string, mix: AudioBuffer, stale?: () => boolean) => {
      const model = getStemModel(stemModelRef.current);
      // Idempotency: skip a repeat derive of the exact same (track, model) on this deck.
      // deriveStems is re-fired by several effects; without this, a desktop load could
      // cycle promote → setStems → promote… A fresh track load clears the guard (see
      // loadTrackToDeck), and a model switch changes the key, so both still re-derive.
      const guardKey = `${videoId}:${model.id}`;
      if (deriveGuard.current[id] === guardKey) return;
      deriveGuard.current[id] = guardKey;

      // "Single" — the plain mix, no stem mixer. This is the no-stems path (the old DSP
      // band/centre split was dropped: it's a poor approximation, so it's single OR neural).
      // On DESKTOP, if auto-enhance is on and a neural set already exists for this track (on
      // disk or pooled in R2), silently promote it — a free quality win with no separation.
      // Otherwise the deck just plays the mix (lightest path, no 424 MB stem set held).
      // In a SESSION whose host is using stems, a phone derives a local DSP set even when its OWN
      // model is "Single" — otherwise a guest sees the host's stem moves but can't HEAR them (the
      // original bug). It falls through to the mobile DSP path below; everyone else treats "off" as
      // the plain no-stems mix.
      const sessionWantsStems =
        isMobileDevice() && snapFollowRef.current && !!lastSnapshotRef.current?.decks?.[id]?.hasStems;
      // LAZY MOBILE-GUEST STEMS (the OOM fix): the deck holds per-stem gain/mute state
      // buffer-free, so a phone session-follower only needs to MATERIALISE real stems once a
      // stem control actually diverges from default (the host ducked/muted one, or a local
      // touch). An idle "just listening" guest — the common case — stays mix-only and skips
      // the ~370 MB resident + ~352 MB transition-transient DSP set that was jetsam-killing
      // phones. `ensureGuestStems` re-invokes deriveStems the instant a value diverges, and
      // this gate then falls through to the mobile FETCH branch below. Desktop is unchanged
      // (sessionWantsStems is mobile-only, so the second clause never fires there).
      const stemDiverged = STEM_KEYS.some(
        (n) => engine.deck(id).stemLevel(n) !== 1 || !engine.deck(id).stemActive(n),
      );
      // Mobile wants stems when the global toggle is on (Settings ▸ Audio ▸ "Use shared stems")
      // OR AUTO is running (a stem transition needs both decks) → fall through to the mobile
      // cached-download path regardless of the mix-only gate. It never separates; see below.
      const mobileWantStems = isMobileDevice() && (mobileStemsRef.current || autoEnabledRef.current);
      if (model.id === "off" && !mobileWantStems && (!sessionWantsStems || (isMobileDevice() && !stemDiverged))) {
        if (!isMobileDevice() && autoEnhanceRef.current) {
          await whenIdle();
          if (stale?.()) return;
          const enhanced = await promoteCachedStems(id, videoId, mix, stale);
          if (stale?.()) return;
          if (enhanced) return; // cached neural applied
        }
        engine.deck(id).setStems(null);
        refresh();
        setStatusFor(id, null);
        return;
      }

      // Let the deck's UI render first — the stem split is background work.
      await whenIdle();
      if (stale?.()) return;

      // MEMORY DISCIPLINE (the iPhone crash fix). A stem SET = 4 full-length stereo
      // float32 buffers (~424 MB for a 5-min track). iOS Safari's ~1–1.5 GB per-tab
      // budget holds ONE set but not TWO — holding the OLD set AND a new neural set at
      // once is what jetsam-killed the tab. So on MOBILE we drop the current set before
      // building a new one: decode/separate exactly one set at a time.
      const mobile = isMobileDevice();
      // On mobile, drop this deck's CURRENT stems before building a new set. On a
      // model switch / re-analyze / cache-enhance there's no setBuffer to free them,
      // so the old set (~424 MB) would be held through the whole new build → OOM. The
      // buttons go inactive for the brief build; we'd rather that than a tab reload.
      if (mobile) {
        engine.deck(id).setStems(null);
        refresh();
      }
      stemTrace(`derive ${id}`, `${model.id}${mobile ? " mobile" : ""}`);

      // ★ HISTORY, so nobody re-adds it: mobile USED to derive stems locally with a lightweight
      // Web Audio DSP separator, and the comment describing that survived here long after the
      // code stopped doing it — directly above the block that says the opposite. It was removed
      // because the offline render competes with the audio thread and, once it packs int16 and
      // frees the mix, can leave the deck SILENT if anything in the pack path hiccups. There is
      // no on-device split on a phone, of any kind, neural or DSP.
      if (mobile) {
        // MOBILE = FETCH + RENDER ONLY. Phones NEVER run on-device separation (neural or the
        // DSP split): that heavy offline render competes with the audio thread and — once it
        // packs int16 + frees the mix — can leave the deck silent if anything in the pack
        // path hiccups. Instead: if a neural set is cached in R2 (the host warmed it, or a
        // past listener), DOWNLOAD + render it; otherwise stay on the PLAIN MIX, which is
        // already in the worklet from setBuffer (so we KEEP the buffer — never releaseMixBuffer
        // on this path — and the deck just keeps playing the mix).
        setStatusFor(id, { phase: "downloading", detail: "Checking for shared stems…" });
        await whenIdle();
        if (stale?.()) return;
        try {
          // Serialise across decks (one download/decode at a time) + the AGGREGATE stem budget,
          // same as before — a 2-deck cached set is the same int16 footprint as a derived one.
          const run = mobileDeriveChain.then(async () => {
            const otherId: DeckId = id === "A" ? "B" : "A";
            // SEATBELT: project THIS set's resident int16 bytes (16 B/sample × length) and add the
            // OTHER deck's already-resident stem bytes. Over budget → decline to the plain mix
            // (below) rather than let the tab OOM. Byte-accurate, unlike the old seconds proxy.
            const incomingBytes = STEM_SET_BYTES_PER_SAMPLE * Math.round(mix.duration * engine.ctx.sampleRate);
            if (engine.deck(otherId).stemBytes + incomingBytes > MOBILE_STEM_BYTE_BUDGET) return { kind: "over" as const };
            // SHARED NEURAL CACHE ONLY. Probe R2 best-first; the first complete set wins and is
            // DOWNLOADED (loadStems takes the no-separation branch on a complete manifest).
            for (const mid of PROMOTE_ORDER) {
              const man = await fetchStemManifest(videoId, mid).catch(() => null);
              if (stale?.()) return { kind: "stale" as const };
              if (!man?.complete) continue;
              const m = getStemModel(mid);
              const src = stemSrcLabel(mid);
              setStatusFor(id, { phase: "downloading", src, detail: `Host's ${m.label} stems — downloading…` });
              try {
                const onPct = (pct: number) => {
                  const p = Math.round(pct * 100);
                  setStatusFor(id, { phase: "downloading", src, pct: p, detail: `Downloading ${m.label} stems… ${p}%` });
                };
                // Decode+pack ONE stem at a time (never the full float32 set) → the OOM-safe path
                // that fixes the 2-long-track crash-loop. null = cache incomplete → float32 fallback.
                const packed = await loadStemsPackedInt16(engine.ctx, videoId, m, onPct);
                if (packed) return { kind: "neuralPacked" as const, packed, mid };
                const stems = await loadStems(engine.ctx, videoId, mix, m, onPct);
                return { kind: "neural" as const, stems, mid };
              } catch {
                break; // download failed → plain mix
              }
            }
            return { kind: "none" as const }; // nothing cached → plain mix (NO on-device separation)
          });
          mobileDeriveChain = run.catch(() => undefined);
          const res = await run;
          if (stale?.() || res?.kind === "stale") return;
          if (res?.kind === "neural") {
            // loadStems throws on any failure (no DSP fallback), and the try above breaks to the
            // plain mix on that — so a "neural" result is always a real downloaded set.
            engine.deck(id).setStems(res.stems, true, videoId); // packs int16 + builds lanes + frees float32
            stemLoadedKey.current[id] = `${videoId}:${res.mid}`;
            // Stems are the worklet's audio source now → free the ~92 MB float32 mix.
            engine.deck(id).releaseMixBuffer();
            dropCachedBuffer(videoId);
            refresh();
            const lanes = Object.keys(engine.deck(id).stemPyramids ?? {}).length;
            setStatusFor(id, { phase: "ready", src: stemSrcLabel(res.mid), detail: `${getStemModel(res.mid).label} stems · ${lanes} lanes` });
          } else if (res?.kind === "neuralPacked") {
            engine.deck(id).loadPackedStems(res.packed, true, videoId); // int16 direct — no float32 set ever held
            stemLoadedKey.current[id] = `${videoId}:${res.mid}`;
            // Stems are the worklet's audio source now → free the ~92 MB float32 mix.
            engine.deck(id).releaseMixBuffer();
            dropCachedBuffer(videoId);
            refresh();
            const lanes = Object.keys(engine.deck(id).stemPyramids ?? {}).length;
            setStatusFor(id, { phase: "ready", src: stemSrcLabel(res.mid), detail: `${getStemModel(res.mid).label} stems · ${lanes} lanes` });
          } else {
            // No cached stems (or over budget) → PLAIN MIX. The worklet already holds it from
            // setBuffer; KEEP the buffer (do NOT releaseMixBuffer) so playback never goes silent.
            engine.deck(id).setStems(null);
            stemLoadedKey.current[id] = guardKey;
            refresh();
            setStatusFor(id, {
              phase: "unavailable",
              detail:
                res?.kind === "over"
                  ? "Both tracks exceed the on-device stem budget — this deck plays the mix."
                  : "No shared stems for this track yet — playing the mix.",
            });
            setTimeout(() => !stale?.() && setStatusFor(id, null), 5000);
          }
        } catch (e) {
          console.warn("[htl] mobile stem fetch failed:", e);
          engine.deck(id).setStems(null); // plain mix; un-latch so a re-tap / reload can retry
          deriveGuard.current[id] = "";
          setStatusFor(id, { phase: "unavailable", detail: "Couldn't load shared stems — playing the mix." });
          setTimeout(() => !stale?.() && setStatusFor(id, null), 5000);
        }
        return;
      }

      // Refresh-fast path: if THIS track's neural stems are already persisted in IndexedDB
      // (from a previous separation/download), decode them straight from disk and apply —
      // NO R2 re-download, NO re-separation. This is what stops a page refresh from redoing
      // the work. (Every selectable model here is neural — "single" returned above.)
      // Already separated + still on this deck (e.g. the model/auto-enhance effect cleared the
      // guard, or the local persist hasn't landed yet) → DON'T re-separate; it's already here.
      if (engine.deck(id).hasStems && stemLoadedKey.current[id] === guardKey) {
        setStatusFor(id, null);
        return;
      }

      // Refresh-fast path: if THIS track's neural stems are already persisted in IndexedDB
      // (from a previous separation/download), decode them straight from disk and apply —
      // NO R2 re-download, NO re-separation. This is what stops a page refresh from redoing
      // the work. (Every selectable model here is neural — "single" returned above.)
      {
        const local = await loadStemsLocal(engine.ctx, videoId, model.id);
        if (local) {
          if (stale?.()) return;
          engine.deck(id).setStems(local, true, videoId); // neural → per-stem lanes
          stemLoadedKey.current[id] = guardKey;
          refresh();
          // Make a cache hit OBVIOUS (green), so it reads differently from a fresh
          // separation — these stems came straight off disk, no work was done. The
          // chip persists (it's the active-stems indicator), clearing on next load.
          setStatusFor(id, {
            phase: "cached",
            src: stemSrcLabel(model.id),
            detail: `${model.label} — cached (loaded from disk).`,
          });
          return;
        }
      }

      const key = `${videoId}:${model.id}`;
      const support = modelSupport(model); // "runs" here | "desktop" | "needs-gpu"

      // Is this model's result already shared in R2? If so, ANY device — phone
      // included — can DOWNLOAD it, even when it can't separate locally.
      const manifest = await fetchStemManifest(videoId, model.id).catch(() => null);
      if (stale?.()) return;
      const cached = !!manifest?.complete;

      // Can't separate here and nobody has yet → stay on the plain mix and say exactly why,
      // instead of a silent fallback or a "Separating…" that never finishes.
      // (Light int8 models already report support==="runs" on phones, so phones DO
      // contribute those; heavy fp32 / GPU stay desktop-gated — forcing them on mobile
      // OOM-kills the tab.)
      if (!cached && support !== "runs") {
        engine.deck(id).setStems(null); // no stems → plain mix
        // In a session, a controlling remote that can't make these (no GPU, etc.) asks the
        // host to separate + stream them instead of a dead end.
        if (requestStemsFromHost(id, model)) return;
        const detail =
          support === "blocked"
            ? `${model.label}: GPU separation was disabled after a crash. Re-enable it in Settings ▸ Stems, or pick a CPU model. Playing the mix.`
            : `${model.label}: separate on ${support === "needs-gpu" ? "a GPU desktop" : "a desktop"} first — playing the mix for now.`;
        setStatusFor(id, { phase: "unavailable", detail });
        setTimeout(() => !stale?.() && setStatusFor(id, null), 6000);
        return;
      }

      // The deck stays on the single mix waveform while the neural set downloads/separates
      // (the "stems incoming" overlay communicates it); the per-stem lanes swap in when the
      // set is ready. No throwaway split is shown first — single OR neural, nothing between.

      // cached → DOWNLOAD the shared stems (any device); else → SEPARATE on-device.
      const phase: StemPhase = cached ? "downloading" : "separating";
      const verb = cached ? "Downloading" : "Separating with";
      // Actual on-device GPU work (not a cached download) can HARD-crash the tab —
      // arm the crash guard so a reload doesn't re-attempt and loop. Disarmed in
      // `finally` (success or caught error both mean the tab survived).
      // A GPU separation can hard-crash the tab; arm the guard around any fresh
      // separation so a crash can't loop. (Separation only exists on Chromium+WebGPU —
      // everywhere else deviceSupportsModel already said no and we never get here.)
      const gpuSeparate = !cached && model.tier === "gpu";
      if (gpuSeparate) armGpu(model.id);
      setStatusFor(id, { phase, pct: 0, detail: `${verb} ${model.label}…` });
      try {
        // Share one job per (track, model): a model toggle, a StrictMode re-fire,
        // or both decks on the same track reuse it instead of stacking heavy work.
        let job = stemJobs.current.get(key);
        if (!job) {
          job = loadStems(engine.ctx, videoId, mix, model, (pct) => {
            const p = Math.round(pct * 100);
            setStatusFor(id, { phase, pct: p, detail: `${verb} ${model.label}… ${p}%` });
          });
          stemJobs.current.set(key, job);
          void job.finally(() => {
            if (stemJobs.current.get(key) === job) stemJobs.current.delete(key);
          });
        }
        const neural = await job;
        if (stale?.()) return;
        // loadStems throws on a separation failure (no DSP fallback) → the catch below plays the
        // plain mix. Reaching here means a real neural set separated/downloaded.
        engine.deck(id).setStems(neural, true, videoId); // real neural → per-stem lanes
        stemLoadedKey.current[id] = guardKey; // remember it's loaded → never re-separate it
        refresh();
        // Persistent active-stems chip (clears on next track load).
        setStatusFor(id, { phase: "ready", src: stemSrcLabel(model.id), detail: `${model.label} ready.` });
      } catch (e) {
        console.warn("[htl] neural stems failed:", e);
        // The neural attempt is over (its memory freed) → fall back to the plain mix.
        engine.deck(id).setStems(null);
        setStatusFor(id, { phase: "failed", detail: `${model.label} failed — playing the mix. See console for details.` });
        setTimeout(() => !stale?.() && setStatusFor(id, null), 6000);
      } finally {
        if (gpuSeparate) disarmGpu();
      }
    },
    [engine, refresh, setStatusFor, promoteCachedStems, requestStemsFromHost],
  );

  // ── WARM AHEAD ────────────────────────────────────────────────────────────────────────────
  //
  // Separate a track that is NOT on a deck, so its stems are already on disk by the time it is.
  //
  // ★ WHY. `ensurePreload` starts the next track's separation as soon as AUTO is armed, which
  // buys the whole of the current track — usually enough, sometimes not. When it isn't, the
  // separation is still running when the mix begins, and the transition either janks (see
  // stems/gpuQueue) or degrades to an EQ blend because `raceStems` finds no stems. Warming the
  // track AFTER next doubles the lead: two tracks instead of one.
  //
  // ★ IT DOES NOT TOUCH THE TRACK CACHE, and that is deliberate. `loadTrackToDeck` treats a
  // populated `getCachedTrack` entry as "analysis already done" and skips the block that reads
  // the shared dataset's stored beatgrid AND the one that posts our own back. A warm pass that
  // called setCachedTrack would silently stop every warmed track from contributing its grid, and
  // make it ignore a better stored one — a real regression, bought for a decode we can afford to
  // repeat. So we decode a THROWAWAY buffer, hand it to the separator, and let it go. The bytes
  // are cached in IndexedDB either way (putAudio), so the deck load re-decodes but never re-fetches.
  //
  // ★ IT RIDES THE SAME JOB MAP. `stemJobs` is keyed `videoId:modelId`, so when the deck load
  // eventually calls deriveStems for this track it finds our in-flight promise and awaits it
  // rather than starting a second separation. The warm and the load converge for free.
  const warming = useRef("");
  const warmStems = useCallback(
    async (videoId: string): Promise<void> => {
      if (!videoId) return;
      // Never on a phone. The mobile path exists to STAY under a memory budget (see
      // MOBILE_STEM_BYTE_BUDGET); speculatively decoding a track nobody asked for is the exact
      // opposite of that trade.
      if (isMobileDevice()) return;
      const model = getStemModel(stemModelRef.current);
      if (model.tier !== "gpu") return; // only the expensive path is worth pre-paying for
      const key = `${videoId}:${model.id}`;
      if (stemJobs.current.has(key)) return; // a deck already asked — it owns the job
      if (warming.current) return; // one speculative separation at a time, ever
      warming.current = videoId;
      stemTrace("warm:start", videoId);
      try {
        // Already separated? The manifest probe is far cheaper than a decode, so ask first.
        // fetchStemManifest always RESOLVES to an object — a miss is `{ stems: [], complete: false }`,
        // not null — so this must test `.complete`, not truthiness. (A truthiness test here would
        // return on every call and the warm would silently never run.)
        const manifest = await fetchStemManifest(videoId, model.id).catch(() => null);
        if (manifest?.complete) {
          stemTrace("warm:cached", videoId);
          return;
        }
        const stored = await getAudio(videoId);
        const data = stored ? stored.bytes : await fetchYouTubeAudio(videoId, () => {});
        if (!stored) void putAudio(videoId, data.slice(0));
        const mix = await decodeAudio(engine.ctx, data);
        // Re-check: the decode took time, and a deck may have claimed this track meanwhile.
        if (stemJobs.current.has(key)) return;
        const job = loadStems(engine.ctx, videoId, mix, model, () => {});
        stemJobs.current.set(key, job);
        void job.finally(() => {
          if (stemJobs.current.get(key) === job) stemJobs.current.delete(key);
        });
        await job;
        stemTrace("warm:done", videoId);
      } catch (e) {
        // Best-effort by construction: a failed warm costs nothing but the attempt, and the deck
        // load will try again for real (with UI status) when the track actually lands.
        stemTrace("warm:failed", `${videoId} ${(e as Error).message ?? e}`);
      } finally {
        warming.current = "";
      }
    },
    [engine, stemModelRef, stemJobs],
  );

  return { deriveStems, warmStems };
}
