import type { AudioEngine, DeckId, FxDevice } from "../audio";
import { foldTempoOctave, nearestBeat } from "../analysis";
import type { TrackMeta } from "../library/types";
import { pickTransition, resolveEntry, resolveStyle, type StyleShape } from "./mixability";
import { type Sections, blendBarsFor, chooseMixIn, chooseMixOut, firstBodySection } from "./mixPoints";
import type { AutoMixPhase, MixMode, RadioContext, StyleCapabilities, TransitionEntry, TransitionPlan, TransitionStyle } from "./types";
import type { FxKind } from "../audio";
import type { AutoFxSettings, AutoPerformance } from "../state/settings";
import type { MixQueue } from "./queue";
import { clamp, lerp } from "../../util/math";
import { event } from "../debug/trace";
import { holdGpu } from "../stems/gpuQueue";

// The AutoMixer is an automated DJ that COOPERATES with a human co-pilot: it drives
// the same engine/deck controls the UI buttons drive, but the user can jog, scratch,
// load, or grab the crossfader at any moment — so every tick re-checks reality
// (reconcile) and the transition itself runs on wall-clock playing-time, not the
// playhead, so scratching a deck can't scramble the fade.
//
// Phases: idle → armed → preload → cueing → mixing → settle → (armed) …
//         + manual: the user grabbed the fader mid-mix; stand back until one deck.

type Deck = ReturnType<AudioEngine["deck"]>;

const EQ_KILL = -26; // dB — the engine's low-shelf floor (a full bass cut)
const END_GUARD = 4; // s — never mix out closer than this to the track end
const BEATS_PER_BAR = 4;
const XFADE_GRAB = 0.06; // crossfade delta that means "the user took the fader"
const STEM_WAIT_MAX = 8; // s — at mix-out, hold this long for the incoming deck's stems to
//                          finish separating before falling back to an EQ blend.

// ── GAIN STAGING ────────────────────────────────────────────────────────────────────────────────
// A DJ trims every channel so each record arrives at the mixer at the same level. AUTO never did,
// so a quiet 2009 upload blending into a loud 2023 master stepped up in volume mid-transition —
// the loudest "a robot is doing this" tell in the whole feature, and the cheapest to remove.
//
// We normalise each deck to a FIXED reference rather than matching the outgoing track. Matching
// the previous track chases its own tail (every mix inherits the last one's error, and a long
// AUTO set drifts steadily louder or quieter), and it would have to JUMP at settle, when the
// incoming is suddenly alone and its "match" no longer refers to anything. One fixed target means
// the whole set sits at one level and settle changes nothing.
const GAIN_REF_RMS = 0.14; // ≈ −17 dBFS integrated RMS — a normal contemporary master
const GAIN_MAX_DB = 6; // never push a track further than this in either direction

/** Trim (linear gain) that brings a track of the given integrated RMS to the reference level,
 *  clamped to ±GAIN_MAX_DB. Returns 1 (leave it alone) for a deck with no buffer or pure silence
 *  — `Deck.loudness` reports 0 in both cases and dividing by it would be an infinite boost. */
export function gainTrim(loudness: number, ref = GAIN_REF_RMS, maxDb = GAIN_MAX_DB): number {
  if (!(loudness > 0)) return 1;
  const lim = Math.pow(10, maxDb / 20);
  return clamp(ref / loudness, 1 / lim, lim);
}

export interface AutoMixStatus {
  enabled: boolean;
  phase: AutoMixPhase;
  liveDeck: DeckId | null;
  plan: TransitionPlan | null;
  mixOutTime: number | null;
  countdownSec: number | null;
}

/** Serializable auto-DJ state the audio host streams to a shared session so remotes
 *  mirror the queue + AUTO status (and can drive it). */
export interface AutoMixMirror {
  status: AutoMixStatus;
  mode: MixMode;
  current: TrackMeta | null;
  upcoming: TrackMeta[];
}

export interface AutoMixerDeps {
  engine: AudioEngine;
  queue: MixQueue;
  loadDeck: (id: DeckId, track: TrackMeta) => Promise<void>;
  deckTrack: (id: DeckId) => TrackMeta | null;
  applyCrossfade: (x: number) => void;
  getCrossfade: () => number;
  now: () => number; // monotonic ms (performance.now) — for wall-clock mix progress
  // True while a deck's stems are still being fetched/separated (not yet loaded). Lets the
  // mixer hold briefly at mix-out for an in-flight separation so the stem swap fires instead
  // of falling back to EQ. Optional — without it the mixer never waits (uses stems if ready).
  stemsPending?: (id: DeckId) => boolean;
  // How much flourish is allowed (Settings ▸ Controls). Read per-transition rather than captured,
  // so changing it takes effect on the very next mix instead of the next AUTO session.
  performance?: () => AutoPerformance;
  /** Where AUTO routes a stem during a transition. The effect itself is the user's AUTO chain. */
  autoFx?: () => AutoFxSettings;
  /** Called once, when AUTO seeds the AUTO chain, so the app can remember not to offer it again. */
  onAutoFxSeeded?: () => void;
  /** Speculatively separate a track that is NOT on a deck — the one AFTER next. Fire-and-forget,
   *  desktop-only, and free to decline (the app's implementation is best-effort). See
   *  useStemPipeline.warmStems for why this doubles the separation lead. */
  warmStems?: (videoId: string) => void;
  onChange: (s: AutoMixStatus) => void;
}

function deckDescriptor(deck: Deck, fallback: TrackMeta | null): TrackMeta {
  return {
    videoId: fallback?.videoId ?? "",
    title: fallback?.title ?? "",
    artist: fallback?.artist ?? "",
    duration: deck.duration || (fallback?.duration ?? 0),
    thumbnail: fallback?.thumbnail ?? null,
    views: fallback?.views ?? null,
    key: deck.key?.camelot ?? fallback?.key ?? null,
    bpm: deck.beatgrid?.bpm ?? fallback?.bpm ?? null,
  };
}

// ★ WHAT USED TO BE HERE, AND WHY IT IS GONE. `radioSeedSet()` built the radio's seed set from the
// live deck + the vibe anchor + the other deck, with an elaborate `fedBack` guard excluding the
// idle deck whenever it held our own eager preload — because seeding from a deck we had just
// loaded ourselves flipped the seed signature every tick, bypassed the fill cooldown, refetched
// and replaced the tail, evicted the preload, and span forever. It was pure, exported, and
// unit-tested, and every ensureNext caller routed through it.
//
// It also did nothing. `queue.ensureNext` named its parameter `_legacySeeds` and never read it —
// the refactor that moved seeding into the queue left the entire caller side standing. Forty lines
// of load-bearing-LOOKING code, a guard against a spiral that could no longer happen, and a set of
// tests all asserting the behaviour of a value that was discarded on arrival.
//
// The recursion it guarded against is now structurally impossible for a different reason: the
// radio seeds from the ANCHOR and the CURRENTLY-PLAYING track (see selector.radioSeeds), and a
// preloaded idle deck is neither. The mixer's job is simply to describe the moment — `radioCtx()`
// below — and let the queue decide what that implies.

// WHICH DECK IS LIVE — the single source of truth for "what is the user actually hearing",
// pure + tested so the state machine can never again cling to a deck nobody started. Rules:
//  • exactly one deck playing → that deck (unambiguous).
//  • BOTH playing → follow whichever JUST STARTED this tick (a rising edge = the user dropped a
//    new track under us). This is the bug fix: the old code kept the stale liveId, so starting
//    deck B while the mixer was armed on A left it "mixing out" A — a deck nobody was hearing —
//    with no recovery until A ended. A fresh start is an explicit "this is live now" signal.
//  • both already playing with no new start (a steady manual blend) → keep the current live deck
//    if it's one of the two; else default to A.
//  • nothing playing → null (the caller decides end-of-track vs. paused).
export function decideLive(p: {
  aPlay: boolean;
  bPlay: boolean;
  aPlayPrev: boolean; // was A playing last tick? (rising-edge detection)
  bPlayPrev: boolean;
  liveId: DeckId | null;
}): DeckId | null {
  if (!p.aPlay && !p.bPlay) return null;
  if (p.aPlay && !p.bPlay) return "A";
  if (p.bPlay && !p.aPlay) return "B";
  // Both playing — prefer the deck that just rose (user-started under us).
  const aRose = !p.aPlayPrev;
  const bRose = !p.bPlayPrev;
  if (aRose && !bRose) return "A";
  if (bRose && !aRose) return "B";
  // No clear new-start (both steady, or both rose together) → keep live if valid, else A.
  return p.liveId === "A" || p.liveId === "B" ? p.liveId : "A";
}

export class AutoMixer {
  private enabled = false;
  private phase: AutoMixPhase = "idle";
  private liveId: DeckId | null = null;
  private liveVideoId: string | null = null;
  private cuedIdle: DeckId | null = null;
  private plan: TransitionPlan | null = null;
  private mixOutTime: number | null = null;
  private barsSeconds = 0;
  private preloading = false;
  private nextTrack: TrackMeta | null = null;
  // loadDeck (→ loadTrackToDeck) SWALLOWS failures — it resolves after setting a "failed" status,
  // never throws. So a dead/blocked/undecodable next track resolves as if loaded; without a LANDING
  // check the mixer latches a preload that isn't there and re-loads the same broken track every
  // tick FOREVER. Count consecutive non-landings per videoId; after MAX_LOAD_FAILS, drop it from the
  // queue so the next attempt gets a DIFFERENT track. A transient blip just retries (≤ MAX).
  private loadFails = new Map<string, number>();
  private static readonly MAX_LOAD_FAILS = 2;
  // EAGER PRELOAD: the next track is loaded onto the idle deck the moment the current
  // track starts playing — NOT at the ~30 s mix lead-in — so the (slow) stem separation
  // has the whole current track to finish before the blend. `preloadedTrack`/`preloadedId`
  // record which track is already sitting decoded on which deck; `eagerLoading` guards the
  // async load against re-entry / a racing cue. Cue setup (seek/EQ/crossfade) still runs at
  // mix time, off the already-loaded deck.
  private preloadedId: DeckId | null = null;
  private preloadedTrack: TrackMeta | null = null;
  private eagerLoading = false;
  // Monotonic generation, bumped by skip/cancel/adoptLive. An async load (preload/cue/kickoff)
  // captures it before awaiting and discards its result if it changed during the await — so a
  // Skip mid-preload can't still mix in the just-skipped track (the stale continuation that
  // re-set preloaded* after clearPreload zeroed it). #2.
  private gen = 0;
  // THE SESSION VIBE — the track the user last put on by hand. The radio seeds from this AND the
  // currently-playing track, so a set stays tethered to what the user chose instead of drifting
  // one nearest-neighbour at a time. `anchorAge` counts tracks played since it was set: the anchor
  // decays with age (selector.anchorWeight), because the record you put on eight tracks ago should
  // still colour the room but should not still be choosing the music.
  private anchor: TrackMeta | null = null;
  private anchorAge = 0;
  // Tracks AUTO has played this session — the energy arc's position along its curve.
  private playedCount = 0;
  private mixStarted = false;
  private mixElapsed = 0; // seconds of live-deck playing-time since the mix began
  private useStems = false;
  // Gradual tempo/pitch glide across the blend (see beginGlide/glideTempo/endGlide).
  private glideActive = false;
  // Saved keylock state (non-null only while a non-key-matched "vinyl" glide is dropping
  // keylock so the tempo ramp also pitches the decks) — restored at endGlide.
  private glideKeylock: { A: boolean; B: boolean } | null = null;
  private lastXfade: number | null = null;
  private lastTickMs: number | null = null;
  private lastEmitKey = "";
  // Per-deck playing state from the PREVIOUS tick — lets reconcile() see a rising edge (a deck
  // the user just started) and follow it instead of clinging to a stale liveId. Updated every
  // tick (even mid-mix) so the edge is fresh the moment we return to a reconciling phase.
  private wasPlaying: { A: boolean; B: boolean } = { A: false, B: false };
  // The last gesture used, so the next one can decline to repeat it when it has a real choice.
  // Survives across transitions (it is the whole point) but not across an AUTO session.
  private lastStyle: TransitionStyle | null = null;
  // Devices borrowed from the deck's permanent rack for this transition, with the exact state to
  // hand back. See borrowFx.
  private borrowedFx: { saved: { device: FxDevice; params: Record<string, number>; bypassed: boolean }[] } | null = null;
  private spinFired = false; // spinOut fires once per transition, not once per tick
  // The stem routing we set up for this transition: which deck's AUTO chain is currently hearing a
  // stem, and who held that stem before. A stem has exactly one owner, so claiming it takes it off
  // whichever of the user's chains had it, and settle has to give it back.
  private autoFx: { deckId: DeckId; chainId: string; restore: { id: string; stems: number }[] } | null = null;
  private rollBeats = 0; // current loop-roll length during a dropSwap build (0 = not rolling)
  private holdLoop: DeckId | null = null; // deck currently held in a loop-extend, if any
  private stutterFired = false; // the showy one-bar stutter fires once per transition
  private stutterUntil = 0; // mixElapsed (s) the stutter window closes at
  // ★ THE GPU QUIET WINDOW. Held from the moment a transition is CUED until it settles, so no new
  // stem separation starts while two waveforms are scrolling and the crossfader is sweeping — see
  // stems/gpuQueue. Null when not held; calling the stored function is what releases it, and it is
  // idempotent, so every exit path may call quietGpuEnd() without counting how many times.
  private gpuQuiet: (() => void) | null = null;
  // Last videoId handed to warmStems, so an armed tick every 150 ms doesn't re-ask for the same
  // track forever. Only ever compared, never used to address anything.
  private warmedId = "";
  // Decks whose TRIM we set (gain staging) → the exact value we wrote. Lets stageGain tell "the
  // trim we set last track" from "the user reached over and moved it", so AUTO tunes a channel
  // exactly once per track and never fights a hand on the knob. Cleared on disable.
  private trimSet = new Map<DeckId, number>();

  constructor(private deps: AutoMixerDeps) {}

  isEnabled(): boolean {
    return this.enabled;
  }

  enable(): void {
    if (this.enabled) return;
    this.enabled = true;
    this.lastTickMs = null;
    // Seed the playing-edge snapshot to current reality so the first reconcile doesn't read a
    // phantom rising edge (default-false → "everything just started").
    this.wasPlaying = { A: this.deps.engine.deck("A").playing, B: this.deps.engine.deck("B").playing };
    this.liveId = this.playingDeck();
    this.liveVideoId = this.liveId ? this.deps.deckTrack(this.liveId)?.videoId ?? null : null;
    this.anchor = this.liveId ? this.deps.deckTrack(this.liveId) : null;
    this.anchorAge = 0;
    this.playedCount = 0;
    if (this.liveId && !this.deps.queue.getCurrent()) {
      this.deps.queue.setCurrent(this.deps.deckTrack(this.liveId));
    }
    this.phase = this.liveId ? "armed" : "idle";
    if (this.liveId) this.stageGain(this.liveId); // level the deck we're inheriting
    this.emit(true);
  }

  disable(): void {
    if (!this.enabled) return;
    this.cancel();
    this.releaseGain(); // AUTO's trim is a service, not a setting — hand the channels back at unity
    this.enabled = false;
    this.anchor = null;
    this.anchorAge = 0;
    this.playedCount = 0;
    this.phase = "idle";
    this.emit(true);
  }

  mixNow(): void {
    if (!this.enabled || !this.liveId) return;
    if (this.phase === "armed" || this.phase === "preload" || this.phase === "cueing") {
      this.mixOutTime = this.deps.engine.deck(this.liveId).position();
      void this.tick();
    }
  }

  skip(): void {
    if (!this.enabled) return;
    this.gen++; // invalidate any in-flight preload — it may be loading the track we're skipping
    this.abandonCue();
    this.deps.queue.remove(this.nextTrack?.videoId ?? "");
    this.resetArm();
    this.phase = this.liveId ? "armed" : "idle";
    this.emit(true);
  }

  hold(): void {
    this.cancel();
  }

  /** Abort any in-progress transition and return the decks to a clean state. */
  cancel(): void {
    this.gen++; // invalidate any in-flight preload / cue load
    if (this.phase === "mixing" && this.liveId) {
      const idle = other(this.liveId);
      this.deps.engine.deck(idle).pause();
      this.neutralizeDeck(this.liveId);
      this.neutralizeDeck(idle);
      this.releaseLocks(idle);
      this.endGlide(); // restore keylock dropped for the vinyl glide
      // The cued incoming deck is discarded → return it to natural tempo/key (unlike
      // handoffToManual, which keeps the beatmatch for the user to finish by hand).
      this.deps.engine.deck(idle).setTempo(0);
      this.deps.engine.deck(idle).setPitch(0);
      // The kept (live) deck was the glide master — undo its ramped tempo/pitch too.
      this.deps.engine.deck(this.liveId).setTempo(0);
      this.deps.engine.deck(this.liveId).setPitch(0);
      const sign = this.liveId === "A" ? -1 : 1;
      this.deps.applyCrossfade(sign);
      this.lastXfade = sign;
    } else {
      this.abandonCue();
    }
    this.useStems = false;
    this.returnFx(); // borrowed FX devices must never outlive the transition
    this.endVocalTail(); // …and neither may an AUTO-owned chain
    this.releaseHoldLoop();
    // Unconditional, unlike abandonCue's: the mixing branch above never reaches abandonCue, and a
    // leaked hold would starve stem separation for the rest of the session.
    this.quietGpuEnd();
    this.spinFired = false;
    this.stutterFired = false;
    this.stutterUntil = 0;
    this.resetArm();
    this.phase = this.liveId ? "armed" : "idle";
    this.emit(true);
  }

  // Clear the pending-transition bookkeeping (not the live deck).
  private resetArm(): void {
    this.preloading = false;
    this.mixStarted = false;
    this.mixElapsed = 0;
    this.plan = null;
    this.mixOutTime = null;
    this.nextTrack = null;
    this.clearPreload();
  }

  // Forget the eagerly-preloaded track (the idle deck identity changed, or the queue/next
  // moved) so the next idle deck gets freshly preloaded with the correct upcoming track.
  private clearPreload(): void {
    this.preloadedId = null;
    this.preloadedTrack = null;
  }

  // Did a just-resolved loadDeck actually LAND the track on the deck? On a non-landing, count it
  // and — after MAX_LOAD_FAILS consecutive misses of this videoId — drop the un-loadable track from
  // the queue (+ clear any preload latch) so the next attempt moves on instead of re-loading it
  // forever. A success clears the counter. Returns whether the track is safe to use.
  private landed(videoId: string, deckHasIt: boolean): boolean {
    if (deckHasIt) {
      this.loadFails.delete(videoId);
      return true;
    }
    const n = (this.loadFails.get(videoId) ?? 0) + 1;
    if (n >= AutoMixer.MAX_LOAD_FAILS) {
      this.loadFails.delete(videoId);
      this.deps.queue.remove(videoId); // un-loadable → move past it
      this.clearPreload();
    } else {
      this.loadFails.set(videoId, n);
    }
    return false;
  }

  // GAIN STAGE a deck: bring the track sitting on it to the reference level (see gainTrim).
  // Called once per landed track, on every path that puts audio on a deck.
  //
  // The user always wins. Two hands-off cases:
  //   • we own this deck's trim and it is no longer the value we wrote → they moved it → release
  //     ownership and never touch it again this session;
  //   • we don't own it and it isn't at unity → they set it deliberately before AUTO arrived.
  private stageGain(id: DeckId): void {
    const d = this.deps.engine.deck(id);
    const owned = this.trimSet.get(id);
    if (owned != null && Math.abs(d.trim - owned) > 1e-3) {
      this.trimSet.delete(id); // a hand on the knob outranks us, permanently
      return;
    }
    if (owned == null && Math.abs(d.trim - 1) > 1e-3) return; // pre-existing manual trim
    const loud = d.loudness;
    const t = gainTrim(loud);
    if (owned == null && t === 1) return; // nothing to correct and nothing to own
    d.setTrim(t);
    this.trimSet.set(id, t);
    event("automix.gain", { deck: id, rms: Math.round(loud * 1000) / 1000, trimDb: Math.round(20 * Math.log10(t) * 10) / 10 });
  }

  // Hand every gain-staged deck back at unity. AUTO's trim is a service, not a setting: leaving
  // a −5 dB trim behind after the user switches AUTO off would silently mis-level their manual set.
  private releaseGain(): void {
    for (const [id, v] of this.trimSet) {
      const d = this.deps.engine.deck(id);
      if (Math.abs(d.trim - v) <= 1e-3) d.setTrim(1); // still ours → restore; moved → leave theirs
    }
    this.trimSet.clear();
  }

  // Reset all transition DSP on a deck back to neutral (EQ3, stems, AND the filter —
  // resetEq alone leaves the one-knob filter engaged).
  private neutralizeDeck(id: DeckId): void {
    const d = this.deps.engine.deck(id);
    d.resetEq();
    d.resetStems();
    d.setFilter(0);
  }

  // Undo a cue we set up on the idle deck (restore its EQ/stems/filter, drop the lock).
  private abandonCue(): void {
    // A loop-extend is held on the OUTGOING deck, not the cued one, so it has to be released here
    // too: abandoning the cue means no mix is coming, and a deck left looping never ends.
    this.releaseHoldLoop();
    this.quietGpuEnd(); // no mix coming → stop deferring stem work (same reason as the loop)
    if (this.cuedIdle == null) return;
    const id = this.cuedIdle;
    this.cuedIdle = null;
    this.neutralizeDeck(id);
    this.releaseLocks(id);
  }

  getStatus(): AutoMixStatus {
    return {
      enabled: this.enabled,
      phase: this.phase,
      liveDeck: this.liveId,
      plan: this.plan,
      mixOutTime: this.mixOutTime,
      countdownSec: this.countdown(),
    };
  }

  private countdown(): number | null {
    if (!this.liveId || this.mixOutTime == null) return null;
    if (this.phase !== "armed" && this.phase !== "preload" && this.phase !== "cueing") return null;
    return Math.max(0, this.mixOutTime - this.deps.engine.deck(this.liveId).position());
  }

  private playingDeck(): DeckId | null {
    if (this.deps.engine.deck("A").playing) return "A";
    if (this.deps.engine.deck("B").playing) return "B";
    return null;
  }

  async tick(): Promise<void> {
    if (!this.enabled) return;
    const t = this.deps.now();
    const dt = this.lastTickMs == null ? 0 : Math.min(0.5, (t - this.lastTickMs) / 1000);
    this.lastTickMs = t;

    // Co-pilot: keep the radio queue topped up from BOTH loaded decks (fire & forget).
    void this.maybeFillRadio();
    // Re-sync to reality (user loads / deck switches / pauses) unless mid-transition.
    this.reconcile();

    switch (this.phase) {
      case "idle":
        await this.tryKickoff();
        break;
      case "armed":
        this.tickArmed();
        break;
      case "preload":
        await this.tickPreload();
        break;
      case "cueing":
        this.tickCueing();
        break;
      case "mixing":
        this.tickMixing(dt);
        break;
      case "manual":
        this.tickManual();
        break;
      case "settle":
        break;
    }
    this.emit(false);
  }

  // Keep the queue stocked with suggestions that fit this moment.
  private async maybeFillRadio(): Promise<void> {
    await this.deps.queue.ensureNext(this.radioCtx());
  }

  // One more track played BY AUTO (not by the user reaching over — that path resets the anchor
  // instead, via adoptLive). Both counters advance here and nowhere else, so "how far has the set
  // travelled since the user last chose" and "where are we on the energy curve" stay honest.
  private advancedByAuto(): void {
    this.anchorAge++;
    this.playedCount++;
  }

  // WHAT THE RADIO SHOULD SOUND LIKE RIGHT NOW — the single description every ensureNext caller
  // (fill, preload, advance) passes down. The mixer knows two things the queue cannot: which track
  // the user chose by hand (the vibe anchor) and how far the set has travelled since. It reports
  // both and decides nothing; the selector turns them into seeds and weights.
  private radioCtx(): RadioContext {
    return {
      anchor: this.anchor,
      current: this.liveId ? this.deps.deckTrack(this.liveId) : this.deps.queue.getCurrent(),
      anchorAge: this.anchorAge,
      played: this.playedCount,
      arc: this.deps.queue.arc,
    };
  }

  // Absorb anything the user did to the decks between ticks — GRACEFULLY, so a
  // PAUSE or a manual LOAD is never mistaken for "skip to the next queued song".
  private reconcile(): void {
    const e = this.deps.engine;
    const aPlay = e.deck("A").playing;
    const bPlay = e.deck("B").playing;
    // Record the playing edge for NEXT tick's decideLive — always, even mid-mix, so the edge is
    // accurate when we return to a reconciling phase. Read prev before overwriting.
    const prev = this.wasPlaying;
    this.wasPlaying = { A: aPlay, B: bPlay };
    if (this.phase === "mixing" || this.phase === "settle" || this.phase === "manual") return;

    // Something is playing → follow the deck the user actually has running. When BOTH play (the
    // user started a second deck under us) decideLive follows whichever JUST started, never the
    // stale liveId — the fix for "deck B plays but it thinks A is live, stalls till A ends".
    if (aPlay || bPlay) {
      const playId = decideLive({ aPlay, bPlay, aPlayPrev: prev.A, bPlayPrev: prev.B, liveId: this.liveId }) as DeckId;
      const vid = this.deps.deckTrack(playId)?.videoId ?? null;
      if (this.liveId !== playId || vid !== this.liveVideoId) this.adoptLive(playId);
      return;
    }

    // Nothing playing. A natural END continues autoplay; a PAUSE just holds.
    if (this.liveId) {
      const live = e.deck(this.liveId);
      // "Ended" = past the MUSICAL end (lastSound), so a long dead tail doesn't make autoplay
      // sit through seconds of silence before continuing. Falls back to the file duration.
      const musicalEnd = live.beatgrid?.lastSound && live.beatgrid.lastSound > 0 ? live.beatgrid.lastSound : live.duration;
      const ended = musicalEnd > 0 && live.position() >= musicalEnd - 1.5;
      if (ended && !this.preloading) {
        void this.advanceToNext(); // track finished → hard-load the next (no mix happened)
      }
      // else: the user PAUSED — keep the live context (radio still seeds from it),
      // do NOT advance/skip. A fresh load there is caught by the playing branch above.
      return;
    }
    if (this.phase !== "idle") this.phase = "idle";
  }

  // Adopt a deck as the live one. Re-seeds radio when the track actually changed, so
  // suggestions follow whatever's playing now (not the track we started from).
  private adoptLive(id: DeckId): void {
    this.gen++; // live deck changed under us → any in-flight preload is for the old context
    this.abandonCue();
    const prev = this.liveVideoId;
    this.liveId = id;
    this.liveVideoId = this.deps.deckTrack(id)?.videoId ?? null;
    this.deps.queue.setCurrent(this.deps.deckTrack(id));
    if (this.liveVideoId && this.liveVideoId !== prev) {
      // A user-driven track change resets the "vibe" anchor — suggestions should now
      // tether to what they just put on, not the original auto-mix seed. A fresh anchor is at
      // full strength: age 0.
      this.anchor = this.deps.deckTrack(id);
      this.anchorAge = 0;
      this.deps.queue.reseedRadio();
    }
    this.resetArm();
    this.phase = "armed";
  }

  // Natural track-end autoplay-continue: load + play the next queued track onto the
  // free deck (a plain continue when no mix was in progress).
  private async advanceToNext(): Promise<void> {
    if (this.preloading || !this.liveId) return;
    const g = this.gen;
    const next = await this.deps.queue.ensureNext(this.radioCtx());
    if (!next || !this.enabled || !this.liveId || this.gen !== g) return;
    const target = other(this.liveId);
    if (this.deps.engine.deck(target).playing) return; // don't stomp a deck in use
    this.preloading = true;
    try {
      await this.deps.loadDeck(target, next);
      if (!this.enabled || this.gen !== g) return;
      if (!this.landed(next.videoId, this.deps.deckTrack(target)?.videoId === next.videoId)) return; // didn't land → drop + try a different track
      this.stageGain(target); // level it BEFORE it is audible
      this.deps.engine.deck(target).play();
      const sign = target === "A" ? -1 : 1;
      this.deps.applyCrossfade(sign);
      this.lastXfade = sign;
      this.deps.queue.advance();
      this.advancedByAuto(); // AUTO chose this one — age the anchor, move along the arc
      this.liveId = target;
      this.liveVideoId = next.videoId;
      this.resetArm();
      this.phase = "armed";
    } catch {
      /* retry next tick */
    } finally {
      this.preloading = false;
    }
  }

  private async tryKickoff(): Promise<void> {
    const playing = this.playingDeck();
    if (playing) {
      this.adoptLive(playing);
      return;
    }
    // A deck has a track loaded but PAUSED → adopt it as context (radio seeds from
    // it) WITHOUT auto-playing. This is the key fix: pausing/loading never force-starts
    // the next song. Only a truly empty pair triggers a fresh autoplay start.
    const loaded: DeckId | null = this.deps.deckTrack("A") ? "A" : this.deps.deckTrack("B") ? "B" : null;
    if (loaded) {
      const vid = this.deps.deckTrack(loaded)?.videoId ?? null;
      if (this.liveId !== loaded || this.liveVideoId !== vid) this.adoptLive(loaded);
      return;
    }
    if (this.preloading) return;
    const first = this.deps.queue.advance() ?? this.deps.queue.peekNext();
    if (!first) return;
    const g = this.gen;
    this.preloading = true;
    try {
      await this.deps.loadDeck("A", first);
      if (!this.enabled || this.gen !== g) return;
      if (!this.landed(first.videoId, this.deps.deckTrack("A")?.videoId === first.videoId)) return; // didn't land → drop + try a different track
      this.stageGain("A"); // level it BEFORE it is audible
      this.deps.engine.deck("A").play();
      this.deps.applyCrossfade(-1);
      this.lastXfade = -1;
      this.liveId = "A";
      this.liveVideoId = first.videoId;
      this.deps.queue.setCurrent(first);
      this.phase = "armed";
    } catch {
      /* retry next tick */
    } finally {
      this.preloading = false;
    }
  }

  private liveDeck(): Deck | null {
    return this.liveId ? this.deps.engine.deck(this.liveId) : null;
  }

  private tickArmed(): void {
    const live = this.liveDeck();
    if (!live) {
      this.phase = "idle";
      return;
    }
    if (!live.playing) return; // paused → just wait; never preload/mix off a paused deck
    // Catch the live deck up if we haven't levelled it yet — a user-loaded deck adopted before its
    // buffer finished decoding reports loudness 0, so stageGain declines to own it and we retry
    // here until the decode lands. Cheap: an owned deck exits on the first comparison.
    if (!this.trimSet.has(this.liveId!)) this.stageGain(this.liveId!);
    // AGGRESSIVE PRELOAD: get the next track decoded + (desktop) stem-separated onto the
    // idle deck NOW, while the current track plays — buying the whole track's worth of time
    // for separation instead of the ~30 s lead-in. Fire-and-forget; the cue still happens
    // near mix-out, off the loaded deck. Runs every armed tick but latches once loaded.
    void this.ensurePreload();
    // …and look ONE FURTHER. ensurePreload buys the next track a full track's worth of separation
    // time; this buys the one after it a second track's worth, at the cost of a decode that the
    // warm throws away. Fire-and-forget every armed tick — warmStems latches on its own (one
    // speculative job at a time, skipped entirely if the deck path already claimed the track).
    this.warmAhead();
    if (this.mixOutTime == null) {
      this.barsSeconds = barsToSeconds(12, live.effectiveBpm ?? live.beatgrid?.bpm ?? 0);
      this.mixOutTime = this.computeMixOut(live, this.barsSeconds);
    }
    const lead = this.barsSeconds + 8;
    if (live.position() >= (this.mixOutTime ?? Infinity) - lead) this.phase = "preload";
  }

  // Eagerly load the next queued track onto the idle deck while the current one plays, so
  // the desktop stem pipeline has the whole track to separate before the blend. No cue here
  // (no seek/EQ/crossfade) — just decode + analysis + stems; the cue rides the loaded deck
  // at mix time. Fire-and-forget from tickArmed; idempotent + re-entry-guarded.
  private async ensurePreload(): Promise<void> {
    if (this.eagerLoading || this.preloading || !this.liveId) return;
    const idle = other(this.liveId);
    if (this.deps.engine.deck(idle).playing) return; // user is on that deck — don't grab it
    const g = this.gen;
    const next = await this.deps.queue.ensureNext(this.radioCtx());
    if (!next || !this.enabled || !this.liveId || this.gen !== g) return;
    const tgt = other(this.liveId);
    if (this.deps.engine.deck(tgt).playing) return;
    // Already sitting on the idle deck (we loaded it, or it happens to be there)? Latch it
    // as preloaded so we don't reload — its stems are already deriving.
    if (this.deps.deckTrack(tgt)?.videoId === next.videoId) {
      this.preloadedId = tgt;
      this.preloadedTrack = next;
      return;
    }
    this.eagerLoading = true;
    try {
      await this.deps.loadDeck(tgt, next); // decode + analysis + (desktop) neural stems — EARLY
      if (this.enabled && this.liveId != null && this.gen === g && !this.deps.engine.deck(tgt).playing) {
        // Only latch if it actually LANDED — loadDeck resolves even on a failed load, so latching
        // blind would re-load the same broken track every tick. landed() drops it after MAX misses.
        if (this.landed(next.videoId, this.deps.deckTrack(tgt)?.videoId === next.videoId)) {
          this.preloadedId = tgt;
          this.preloadedTrack = next;
          this.stageGain(tgt); // level it now, long before the blend needs it
        }
      }
    } catch {
      /* transient — retry next tick */
    } finally {
      this.eagerLoading = false;
    }
  }

  private async tickPreload(): Promise<void> {
    if (this.preloading || this.eagerLoading || !this.liveId) return; // wait out an in-flight eager load
    const idle = other(this.liveId);
    // Never grab a deck the user is playing (manual beatmix) — defer.
    if (this.deps.engine.deck(idle).playing) {
      this.phase = "armed";
      return;
    }
    // Prefer the eagerly-preloaded track already decoded on the idle deck (its stems had the
    // whole current track to derive); only load here as a fallback if the early preload
    // hasn't landed yet.
    const preloaded =
      this.preloadedId === idle && !!this.preloadedTrack && this.deps.deckTrack(idle)?.videoId === this.preloadedTrack.videoId;
    const g = this.gen;
    const next = preloaded ? this.preloadedTrack! : await this.deps.queue.ensureNext(this.radioCtx());
    if (!next) {
      this.phase = "armed"; // nothing queued yet — radio may fill, retry later
      return;
    }
    this.preloading = true;
    try {
      if (!preloaded) await this.deps.loadDeck(idle, next);
      // Bail if the world changed under us during the async load (incl. a skip/cancel/adopt
      // that bumped the generation — otherwise we'd cue the stale next track).
      if (!this.enabled || this.liveId == null || this.gen !== g || this.deps.engine.deck(idle).playing) {
        this.phase = "armed";
        return;
      }
      // A fresh (non-preloaded) load that didn't LAND → drop it (in landed) and retry a different
      // track next cycle, rather than cueing a deck that never got the track.
      if (!preloaded && !this.landed(next.videoId, this.deps.deckTrack(idle)?.videoId === next.videoId)) {
        this.phase = "armed";
        return;
      }
      this.stageGain(idle); // idempotent — a preloaded deck was already levelled at preload time
      this.markDropCue(idle); // give "Mix now" somewhere musical to jump to
      this.nextTrack = next;
      const live = this.deps.engine.deck(this.liveId);
      const inc = this.deps.engine.deck(idle);
      this.plan = pickTransition(deckDescriptor(live, this.deps.queue.getCurrent()), deckDescriptor(inc, next));
      const bpm = live.effectiveBpm ?? live.beatgrid?.bpm ?? 0;
      // FIT THE BLEND TO THE SECTION. The planner asks for a length based on how compatible the
      // pair is; the track decides whether it has that much to give. A 24-bar blend that starts
      // 12 bars before the outro ends straddles the seam and sounds like a mistake, so the
      // requested length is capped by the section actually available and quantised to a real
      // phrase length. Two passes: choose an exit with the requested length, then re-measure —
      // a shortened blend can leave later, which is usually the better exit.
      this.barsSeconds = barsToSeconds(this.plan.bars, bpm);
      const liveSections = this.sectionsOf(live);
      if (liveSections) {
        const provisional = this.computeMixOut(live, this.barsSeconds);
        const fitted = blendBarsFor(liveSections, provisional, bpm, this.plan.bars);
        if (fitted !== this.plan.bars) {
          this.plan = { ...this.plan, bars: fitted, bassSwapBar: Math.max(1, Math.round((this.plan.bassSwapBar / this.plan.bars) * fitted)) };
          this.barsSeconds = barsToSeconds(fitted, bpm);
        }
      }
      this.mixOutTime = this.computeMixOut(live, this.barsSeconds);
      const mixIn = this.computeMixIn(inc, this.barsSeconds);
      inc.seek(mixIn);
      // LOOP EXTEND. When the incoming track has a long intro, the honest options are to cut into
      // the middle of it or to start the blend early and let the outgoing die under it. A DJ takes
      // the third one: hold the outgoing on a loop and let the intro play out. Flagged when the
      // incoming's body is further from its cue point than the planned blend can cover, and only
      // when the outgoing has a grid to loop cleanly on.
      const incSections = this.sectionsOf(inc);
      const bodyIdx = incSections ? firstBodySection(incSections) : null;
      const bodyAt = bodyIdx != null && incSections ? incSections.starts[bodyIdx] : null;
      this.plan = {
        ...this.plan,
        loopExtend: !!live.beatgrid && bodyAt != null && bodyAt - mixIn > this.barsSeconds * 1.35,
      };
      inc.setEqLow(EQ_KILL);
      const sign = this.liveId === "A" ? -1 : 1;
      this.deps.applyCrossfade(sign);
      this.lastXfade = sign;
      this.cuedIdle = idle;
      this.mixStarted = false;
      // From here to settle the screen is animating continuously — hold off any new separation.
      this.quietGpuStart();
      this.phase = "cueing";
    } catch {
      this.abandonCue();
      this.phase = "armed";
    } finally {
      this.preloading = false;
    }
  }

  private tickCueing(): void {
    const live = this.liveDeck();
    if (!live || !this.liveId) {
      this.abandonCue();
      this.phase = "armed";
      return;
    }
    const idle = other(this.liveId);
    // User started the cued deck themselves → hand it back.
    if (this.deps.engine.deck(idle).playing) {
      this.abandonCue();
      this.phase = "armed";
      return;
    }
    if (live.position() >= (this.mixOutTime ?? Infinity) - 0.05) {
      // Reached mix-out: prefer a stem swap. If the incoming deck is still separating its
      // stems, hold a moment (bounded) rather than drop to an EQ blend.
      if (this.shouldHoldForStems(live, idle)) return;
      this.startMix();
    } else if (this.plan?.loopExtend && !this.holdLoop && this.nearMixOut(live, this.barsSeconds)) {
      // A bar before the exit, close the outgoing into a 4-bar loop. It keeps playing musically
      // (the same phrase, in time) instead of running out, which buys the incoming's long intro
      // the room it needs. Released the moment the mix actually starts.
      live.setBeatLoop(4);
      this.holdLoop = this.liveId;
    }
  }

  // Within one bar of the planned exit — the point where a loop-extend has to close, since a loop
  // taken later would start mid-phrase.
  private nearMixOut(live: Deck, barsSeconds: number): boolean {
    if (this.mixOutTime == null || !this.plan) return false;
    const oneBar = barsSeconds / Math.max(1, this.plan.bars);
    return live.position() >= this.mixOutTime - oneBar;
  }

  // Drop a loop-extend hold. The mix is starting (or being abandoned), so the outgoing must run
  // on freely again — a deck left looping is a track that never ends.
  private releaseHoldLoop(): void {
    // The drop-swap roll rides the same deck and the same loop engine as a hold, so it is released
    // in the same act — otherwise a transition abandoned mid-roll leaves a deck looping one beat.
    if (this.rollBeats && this.liveId) {
      this.rollBeats = 0;
      try {
        this.deps.engine.deck(this.liveId).exitLoop();
      } catch {
        /* gone with the deck */
      }
    }
    if (!this.holdLoop) return;
    try {
      this.deps.engine.deck(this.holdLoop).exitLoop();
    } catch {
      /* deck reloaded under us — the loop went with it */
    }
    this.holdLoop = null;
  }

  // At mix-out, should we wait for the incoming deck's stems to finish? Only when the
  // outgoing already has stems (a swap is possible), the incoming's are actively separating,
  // and there's both time budget (STEM_WAIT_MAX) and runway left before the outgoing's
  // musical end — so a slow/stuck separation can never ride the blend into the dead tail.
  private shouldHoldForStems(live: Deck, idle: DeckId): boolean {
    const inc = this.deps.engine.deck(idle);
    if (inc.hasStems || !live.hasStems) return false; // ready, or no swap possible → go
    if (!this.deps.stemsPending?.(idle)) return false; // nothing coming → don't wait
    const waited = live.position() - (this.mixOutTime ?? live.position());
    if (waited > STEM_WAIT_MAX) return false;
    const grid = live.beatgrid;
    const end = grid?.lastSound && grid.lastSound > live.duration * 0.5 ? grid.lastSound : live.duration;
    if (end && live.position() > end - this.barsSeconds - 1) return false; // protect the tail
    return true;
  }

  // What the decks can actually do RIGHT NOW. The planner works from track metadata; these are
  // engine facts, and they are only true at the instant the mix starts (stems may have finished
  // separating since preload; the user may have pulled a delay out of the rack).
  private capabilities(liveId: DeckId, idleId: DeckId): StyleCapabilities {
    const live = this.deps.engine.deck(liveId);
    const inc = this.deps.engine.deck(idleId);
    const incSections = this.sectionsOf(inc);
    return {
      stems: live.hasStems && inc.hasStems,
      fx: !!this.findFx(liveId),
      incomingBody: !!incSections && firstBodySection(incSections) != null,
      grid: !!live.beatgrid && !!inc.beatgrid,
    };
  }

  // Is the channel FX rack reachable on this deck? The pad-FX bank is permanently resident
  // (Deck.PERMANENT_KINDS), so this is a sanity probe rather than a real question — but a deck
  // caught mid-reload can have a rack that is not yet wired, and finding that out HERE degrades
  // the plan to a plain blend instead of throwing part-way through a transition.
  private findFx(id: DeckId): FxDevice | null {
    try {
      return this.deps.engine.deck(id).rack.device({ chain: "master", kind: "reverb" }) ?? null;
    } catch {
      return null;
    }
  }

  // ── BORROWING THE FX RACK ─────────────────────────────────────────────────────────────────────
  // ★ THE RACK IS ALREADY FULLY STOCKED, WHICH MAKES ALL OF THIS FREE. Every deck permanently
  // carries delay, reverb, saturator, crush, mod, gate and noise (Deck.PERMANENT_KINDS — a
  // fixed-membership rack), each sitting DORMANT: bypassed, wet pruned, zero CPU, one call from
  // firing. So the auto-mixer never has to add a device, and the earlier caution about not
  // mutating the user's rack costs nothing — there is nothing to mutate. An earlier version gated
  // the echo throw on the user happening to keep a delay on the channel; that was simply wrong
  // about the rack, and it made the best-sounding transitions the rarest ones.
  //
  // What IS owed back is state. A borrowed device returns with every param and its bypass exactly
  // as found, on every exit path, or the user's next manual throw fires with AUTO's settings on it.
  private borrowFx(id: DeckId, kinds: FxKind[]): Partial<Record<FxKind, FxDevice>> {
    const out: Partial<Record<FxKind, FxDevice>> = {};
    const deck = this.deps.engine.deck(id);
    const saved: { device: FxDevice; params: Record<string, number>; bypassed: boolean }[] = [];
    for (const kind of kinds) {
      try {
        // The MASTER chain's copy specifically — a stem chain may hold its own instance of the
        // same kind, and that one belongs to whatever the user routed through it.
        const d = deck.rack.device({ chain: "master", kind });
        if (!d) continue;
        saved.push({ device: d, params: d.snapshotParams(), bypassed: d.bypassed });
        d.setBypass(false);
        out[kind] = d;
      } catch {
        /* an unfamiliar rack shape — skip it; the gesture degrades without that device */
      }
    }
    if (saved.length) this.borrowedFx = { saved: [...(this.borrowedFx?.saved ?? []), ...saved] };
    return out;
  }

  /** Give every borrowed device back exactly as found. Idempotent and never throws. */
  private returnFx(): void {
    const b = this.borrowedFx;
    if (!b) return;
    this.borrowedFx = null;
    for (const s of b.saved) {
      try {
        for (const k in s.params) s.device.setParam(k, s.params[k]);
        s.device.setBypass(s.bypassed, true);
      } catch {
        /* device disposed under us (deck reload) — nothing to restore */
      }
    }
  }

  // Set up whichever device this gesture drives. These are STARTING states only; the ramps live in
  // tickMixing so they ride the same wall-clock progress as the crossfade and cannot drift from it.
  private armGesture(style: TransitionStyle, liveId: DeckId): void {
    if (style === "echoOut") {
      const { delay } = this.borrowFx(liveId, ["delay"]);
      if (!delay) return;
      delay.setParam("sync", 1); // tempo-locked repeats, not an arbitrary time
      delay.setParam("div", 2); // 1/8 — fast enough to blur, slow enough to still hear the phrase
      delay.setParam("feedback", 0.62);
      delay.setParam("mix", 0); // ramped in
    } else if (style === "washOut") {
      const { reverb } = this.borrowFx(liveId, ["reverb"]);
      if (!reverb) return;
      reverb.setParam("size", 0.85);
      reverb.setParam("decay", 0.8);
      reverb.setParam("mix", 0);
    } else if (style === "gateChop") {
      const { gate } = this.borrowFx(liveId, ["gate"]);
      if (!gate) return;
      gate.setParam("sync", 1); // on the grid, or it is just noise
      gate.setParam("rate", 0.25);
      gate.setParam("duty", 0.5);
      gate.setParam("smooth", 0.12);
      gate.setParam("depth", 0);
    }
  }

  // Step the loop-roll to `beats` (0 = stop). Acts only on a CHANGE, so the caller can hand it the
  // current step every tick. Grid-gated: a roll without a beatgrid is a stutter in the wrong place.
  private loopRoll(live: Deck, beats: number, showyOnly = true): void {
    if (this.rollBeats === beats) return;
    if (beats > 0 && ((showyOnly && this.perf() !== "showy") || !live.beatgrid)) return;
    this.rollBeats = beats;
    try {
      if (beats > 0) live.setBeatLoop(beats);
      else live.exitLoop();
    } catch {
      this.rollBeats = 0; // deck reloaded under us
    }
  }

  // ── per-stem FX: routing a stem through the deck's own AUTO chain ─────────────────────────────
  // The stem swap already hands the vocal over with a GAP — the outgoing ducks out by mid-blend,
  // the incoming drops in late, so two leads never sit on top of each other. But the outgoing vocal
  // just STOPS, which is the one moment left that sounds like an automation curve rather than a
  // person. An effect on that stem ALONE fixes it: the vocal dissolves into a tail while drums and
  // bass carry on dry. Only sayable because the rack supports per-stem chains — on a summed channel
  // the same reverb washes the whole track, which is what `washOut` is for.
  //
  // ★ THE EFFECT IS THE USER'S, NOT OURS. It lives in a REAL, PERSISTENT chain in their rack named
  // AUTO, which they edit like any other chain. AUTO's entire involvement is to claim the target
  // stem into it for the length of the transition and release it at settle. We never create a
  // device, never write a param, never touch what is in there. So whatever they have dialled is
  // what plays, editing it mid-transition is coherent (the chain outlives the mix), and there is
  // nothing to arbitrate — the earlier design, which stamped a throwaway chain from a Settings
  // recipe, existed only because the chain used to be ours.
  private static readonly STEM_BIT: Record<AutoFxSettings["stem"], number> = {
    drums: 0b0001,
    bass: 0b0010,
    vocals: 0b0100,
    other: 0b1000,
  };
  static readonly AUTO_CHAIN = "AUTO";
  /** Iteration order for the per-stem writes. Named so the swap can't silently skip one. */
  private static readonly STEMS = ["drums", "bass", "vocals", "other"] as const;

  /** The deck's AUTO chain, seeded ONCE if it has never existed on this device. A user who deletes
   *  it has deleted it — that is how the tail is turned off — so `seeded` is sticky. */
  private autoChainOf(deck: Deck): { id: string } | null {
    const existing = deck.rack.chainList.find((c) => !c.master && c.name === AutoMixer.AUTO_CHAIN);
    if (existing) return { id: existing.id };
    if (this.deps.autoFx?.().seeded) return null; // offered once already, and they removed it
    const chain = deck.addFxChain(AutoMixer.AUTO_CHAIN, 0); // claims nothing → silent until routed
    deck.addFxTo(chain.id, "reverb"); // a starting point they can replace; we never touch it again
    this.deps.onAutoFxSeeded?.();
    event("automix.tail", { at: "seed" });
    return { id: chain.id };
  }

  private beginVocalTail(id: DeckId): void {
    if (this.autoFx || this.perf() === "subtle") return;
    const deck = this.deps.engine.deck(id);
    if (!deck.hasStems) return; // no stems → no per-stem routing → nothing to say
    try {
      const chain = this.autoChainOf(deck);
      if (!chain) return;
      const stem = this.deps.autoFx?.().stem ?? "vocals";
      const bit = AutoMixer.STEM_BIT[stem] ?? 0b0100;
      // Whoever holds that stem loses it for the duration — the rack enforces one owner — so record
      // the previous ownership to hand back. setFxChainStems, never addFxChain's mask: only the
      // former enforces the partition, and two chains holding a bit makes the rack play it twice.
      const restore = deck.rack.chainList
        .filter((c) => !c.master && c.id !== chain.id && (c.stems & bit) !== 0)
        .map((c) => ({ id: c.id, stems: c.stems }));
      deck.setFxChainStems(chain.id, bit);
      this.autoFx = { deckId: id, chainId: chain.id, restore };
      event("automix.tail", { deck: id, at: "route", stem });
    } catch {
      this.autoFx = null; // unexpected rack shape — the blend is fine without the flourish
    }
  }

  // Release the stem. The chain STAYS — it is the user's, and it is silent again the moment it
  // claims nothing. Tolerant of it having gone under us (they deleted it mid-mix, a deck reload).
  private endVocalTail(): void {
    const fx = this.autoFx;
    if (!fx) return;
    this.autoFx = null;
    try {
      const deck = this.deps.engine.deck(fx.deckId);
      if (deck.rack.chain(fx.chainId)) deck.setFxChainStems(fx.chainId, 0);
      for (const r of fx.restore) if (deck.rack.chain(r.id)) deck.setFxChainStems(r.id, r.stems);
      event("automix.tail", { deck: fx.deckId, at: "release" });
    } catch {
      /* the deck moved on — the routing went with it */
    }
  }

  // ★ THE STEM RACE. Whether the incoming is separated by mix time is genuinely a race, and it used
  // to be resolved exactly once, at startMix — wrong in both directions:
  //   • A 24-bar blend at 128 bpm is 45 seconds. Separation landing ten seconds in was ignored: the
  //     mixer had committed to an EQ blend and rode it out, wasting stems it now had. UPGRADE.
  //   • On mobile, releaseMixBuffer drops stems mid-blend under memory pressure. The mixer kept
  //     calling setStemGain on a deck with none, so the arrangement swap silently stopped and the
  //     transition became a bare crossfade with NO bass handover — two low ends at once. DEGRADE.
  private raceStems(live: Deck, inc: Deck, idle: DeckId, p: number): void {
    const both = live.hasStems && inc.hasStems;

    if (this.useStems && !both) {
      live.resetStems();
      inc.resetStems();
      this.endVocalTail();
      this.useStems = false;
      if (this.plan) this.plan = { ...this.plan, style: "blend" };
      event("automix.stems", { at: "degrade", p: Math.round(p * 100) / 100 });
      return;
    }

    if (!this.useStems && both && this.plan?.style === "blend") {
      // UPGRADE only BEFORE the bass swap starts. After it the low end is already part-way across
      // on the EQ path and switching would jump it; before it, both paths agree the incoming has no
      // bass yet, so the change is inaudible.
      const swapStart = this.plan.bassSwapBar / Math.max(1, this.plan.bars);
      if (p >= swapStart) return;
      live.setEqLow(0);
      live.setEqHigh(0);
      live.setFilter(0);
      inc.setEqLow(0);
      inc.setFilter(0);
      inc.setStemGain("bass", 0);
      inc.setStemGain("drums", 0);
      inc.setStemGain("other", 0);
      inc.setStemGain("vocals", 0);
      this.useStems = true;
      this.plan = { ...this.plan, style: "stemswap" };
      this.beginVocalTail(this.liveId ?? idle);
      event("automix.stems", { at: "upgrade", p: Math.round(p * 100) / 100 });
    }
  }

  // Park a hot cue on the incoming track's first body section — its drop. Costs nothing, is where a
  // human would put one, and gives "Mix now" (and the user's own pad 1) a musical destination
  // instead of the top of the file. Slot 0 only, and only when empty: their cues are theirs.
  private markDropCue(id: DeckId): void {
    if (this.perf() === "subtle") return;
    const deck = this.deps.engine.deck(id);
    try {
      if (deck.slotIsSet(0)) return;
      const sections = this.sectionsOf(deck);
      const idx = sections ? firstBodySection(sections) : null;
      if (!sections || idx == null) return;
      const at = sections.starts[idx];
      if (!(at > 0)) return;
      const was = deck.position();
      deck.seek(at);
      deck.hotCue(0);
      deck.seek(was);
    } catch {
      /* a deck mid-reload — the cue is a convenience, never worth an exception */
    }
  }

  private perf(): AutoPerformance {
    return this.deps.performance?.() ?? "standard";
  }

  // MICRO-PERFORMANCE — the small things that read as a person rather than a fader automation.
  // Applied ON TOP of whatever gesture is running, never instead of it. All off under "subtle".
  private microPerform(live: Deck, inc: Deck, p: number): void {
    const perf = this.perf();
    if (perf === "subtle") return;
    void live;

    // THE LIFT. A DJ nudges the treble up on the record taking over — it is how the new track feels
    // like it ARRIVED rather than merely faded up. The neutralise pass at settle reverts it.
    if (!this.useStems) inc.setEqHigh(lerp(0, 2, clamp((p - 0.5) / 0.4, 0, 1)));

    // THE STUTTER. One bar of gating on the way out at the bass swap, on a pair we KNOW fits — a
    // flourish on an unproven transition is just noise on top of a guess.
    if (perf === "showy" && this.plan?.confident && this.plan.score >= 0.6 && !this.stutterFired) {
      const swapAt = this.plan.bassSwapBar / Math.max(1, this.plan.bars);
      if (p >= swapAt && p < swapAt + 0.08) {
        this.stutterFired = true;
        this.stutterUntil = this.mixElapsed + Math.max(0.4, this.barsSeconds / Math.max(1, this.plan.bars));
      }
    }
  }

  private startMix(): void {
    if (this.mixStarted || !this.liveId || !this.plan) return;
    const idle = other(this.liveId);
    const live = this.deps.engine.deck(this.liveId);
    const inc = this.deps.engine.deck(idle);
    const engine = this.deps.engine;

    // Choose the gesture: what suits this pair, filtered by what the decks can do, and biased
    // away from whatever the last transition was. `useStems` follows the decision rather than
    // driving it — a stem swap is now one option among several rather than an automatic upgrade.
    const caps = this.capabilities(this.liveId, idle);
    const shape = this.styleShape(idle);
    const style = resolveStyle(this.plan, caps, this.lastStyle, { shape });
    this.plan.style = style;
    // …and how the incoming ARRIVES, which is now a separate decision from how the outgoing leaves.
    this.plan.entry = resolveEntry(style, caps, shape);
    // The acapella hold, when the harmony actually permits it. keyKnown is the load-bearing half:
    // pickTransition reports keyMatch:true for an UNKNOWN pair too (a neutral guess), and holding
    // a lead vocal over a bed on that guess is the way this move goes badly wrong. Unknown is not
    // permission. Subtle taste sits it out, like every other flourish.
    this.plan.acapella =
      style === "stemswap" && this.plan.keyMatch && this.plan.keyKnown && this.perf() !== "subtle";
    this.lastStyle = style;
    this.useStems = style === "stemswap";
    event("automix.transition", {
      style,
      entry: this.plan.entry,
      bars: this.plan.bars,
      score: Math.round(this.plan.score * 100) / 100,
      confident: this.plan.confident,
      caps: `${caps.stems ? "s" : ""}${caps.fx ? "f" : ""}${caps.incomingBody ? "b" : ""}${caps.grid ? "g" : ""}`,
      loopExtend: !!this.plan.loopExtend,
    });

    this.armGesture(style, this.liveId);
    if (this.useStems) {
      this.beginVocalTail(this.liveId); // the outgoing vocal gets somewhere to dissolve into
      // The incoming enters as DRUMS + BASS only — its melody (other) and vocal come in
      // LATER in the blend (beats → melody → vocal), so nothing stacks on the way in.
      inc.setEqLow(0);
      inc.setStemGain("bass", 0);
      inc.setStemGain("drums", 0);
      inc.setStemGain("other", 0);
      inc.setStemGain("vocals", 0);
    } else if (this.plan.style === "filter") {
      inc.setFilter(-0.85); // start muffled (low-pass) — opens across the mix
    } else if (this.plan.style === "dropSwap") {
      // The incoming arrives WHOLE and unmasked at the cut; nothing to prepare on it. All the
      // work is on the outgoing, which collapses away underneath (see tickMixing).
      inc.setEqLow(0);
      inc.setFilter(0);
    } else if (this.plan.style === "spinOut") {
      inc.setEqLow(0);
    }
    if (engine.syncRole(idle) !== "slave") engine.toggleSync(idle);
    if (this.plan.keyMatch && engine.keyRole(idle) !== "slave") engine.toggleKey(idle);
    this.beginGlide(live, inc);
    inc.play();
    this.cuedIdle = idle; // still ours through the mix
    this.mixStarted = true;
    this.mixElapsed = 0;
    this.phase = "mixing";
  }

  // Set up the gradual tempo/pitch glide at the start of a mix. Instead of the incoming
  // snapping back to its natural BPM at settle, the OUTGOING (sync master) tempo will ramp
  // from its own BPM to the incoming's across the blend and the slave follows continuously
  // (matchSlaveTempo) — so by settle both sit at the incoming's natural tempo, no jump.
  // CONTEXTUAL pitch: when the plan isn't holding a harmonic key-match, drop keylock on
  // both decks so the same tempo ramp also pitches them together (a turntable-style blend —
  // the worklet pitch rides effRate continuously, smooth, unlike integer-semitone setPitch).
  // When key-matching, keylock stays on → pitch holds at the harmonic match.
  private beginGlide(live: Deck, inc: Deck): void {
    this.glideActive = false;
    this.glideKeylock = null;
    if (!live.beatgrid?.bpm || !inc.beatgrid?.bpm) return; // no grid → keep the hard handoff
    this.glideActive = true;
    // The glide COMMANDS the master's tempo off its grid (glideTempo), so tell SYNC to drop the
    // grid-rubato feed-forward — it assumes grid-natural playback and otherwise fights the ramp,
    // making the slave's trim oscillate: random tempo jumps mid-fade. During a commanded ramp the
    // phase-lock rides pure PI with the full ±SYNC_TRIM_MAX headroom (the same signal the Smart
    // Fader sets on arm; endGlide clears it). Without this every auto-transition wobbled.
    this.deps.engine.setCommandedRamp(true);
    if (!this.plan?.keyMatch) {
      this.glideKeylock = { A: this.deps.engine.deck("A").keylock, B: this.deps.engine.deck("B").keylock };
      // PIN keylock off (not just setKeylock(false)) for the vinyl pitch ride: pinning also stops
      // setPitch from silently re-engaging keylock on a user KEY-nudge mid-glide (Deck.setPitch),
      // which would freeze the pitch ramp. endGlide unpins and restores the pre-glide snapshot.
      live.setKeylockPinnedOff(true);
      inc.setKeylockPinnedOff(true);
    }
  }

  // Per-tick tempo ramp on the master; the sync slave follows via the engine's tempo hook.
  private glideTempo(live: Deck, idle: DeckId, p: number): void {
    if (!this.glideActive) return;
    const og = live.beatgrid?.bpm;
    const ig = this.deps.engine.deck(idle).beatgrid?.bpm;
    if (!og || !ig) return;
    // Fold the incoming BPM into the outgoing's tempo octave (half/double) — the same rule
    // the sync slave uses (shared foldTempoOctave, guarded) — minimal ≤√2 move, not a 2× lurch.
    const targetIn = foldTempoOctave(ig, og);
    if (targetIn == null) return;
    const eased = p * p * (3 - 2 * p); // smoothstep — gentle at both ends
    const targetBpm = og + (targetIn - og) * eased;
    live.setTempo((targetBpm / og - 1) * 100); // master moves; slave follows automatically
  }

  // Tear down the glide: restore the keylock we dropped for the vinyl pitch ride. (Tempo
  // resets are handled by the caller — settle/cancel reset to natural, handoff keeps them.)
  private endGlide(): void {
    if (this.glideKeylock) {
      // Clear the pin FIRST, then restore the pre-glide keylock on each deck (so the user's
      // baseline — typically keylock ON — returns after the transition).
      this.deps.engine.deck("A").setKeylockPinnedOff(false);
      this.deps.engine.deck("B").setKeylockPinnedOff(false);
      this.deps.engine.deck("A").setKeylock(this.glideKeylock.A);
      this.deps.engine.deck("B").setKeylock(this.glideKeylock.B);
      this.glideKeylock = null;
    }
    this.glideActive = false;
    this.deps.engine.setCommandedRamp(false); // ramp done → normal beatmatch sync (feed-forward re-acquires)
  }

  private tickMixing(dt: number): void {
    const live = this.liveDeck();
    if (!live || !this.liveId || !this.plan || this.mixOutTime == null) {
      this.settle();
      return;
    }
    const idle = other(this.liveId);
    const inc = this.deps.engine.deck(idle);

    // The user grabbed the crossfader → they're finishing the mix; stand back.
    const cf = this.deps.getCrossfade();
    if (this.lastXfade != null && Math.abs(cf - this.lastXfade) > XFADE_GRAB) {
      this.handoffToManual();
      return;
    }
    // The user stopped the incoming deck → hand off rather than fight.
    if (!inc.playing) {
      this.handoffToManual();
      return;
    }

    // Progress on wall-clock PLAYING time, so jogging/scratching the deck can't
    // scramble the fade. Pauses simply freeze it.
    if (live.playing) this.mixElapsed += dt;
    const p = clamp(this.mixElapsed / Math.max(0.001, this.barsSeconds), 0, 1);

    const liveSign = this.liveId === "A" ? -1 : 1;
    const cfv = lerp(liveSign, -liveSign, p);
    this.deps.applyCrossfade(cfv);
    this.lastXfade = cfv;

    // Gradual tempo glide (and coupled vinyl pitch when not key-matching) — moves the
    // blended tempo from the outgoing BPM to the incoming BPM so settle never snaps.
    this.glideTempo(live, idle, p);

    // Re-resolve the stem race BEFORE the style branches below, so the branch that runs this tick
    // is the one the decks can actually support right now — not the one they could support when
    // the transition started.
    this.raceStems(live, inc, idle, p);

    const swapStart = this.plan.style === "cut" ? 0 : this.plan.bassSwapBar / Math.max(1, this.plan.bars);
    const swapSpan = 1 / Math.max(1, this.plan.bars);
    const s = clamp((p - swapStart) / Math.max(0.001, swapSpan), 0, 1);
    if (this.useStems) {
      const g = stemBlend(p, s, { keyMatch: this.plan.keyMatch, acapella: !!this.plan.acapella });
      for (const k of AutoMixer.STEMS) {
        live.setStemGain(k, g.live[k]);
        inc.setStemGain(k, g.inc[k]);
      }
    } else if (this.plan.style === "dropSwap") {
      // THE DROP SWAP. Not a blend at all: the outgoing COLLAPSES — its bass is pulled and a
      // high-pass climbs until only a thin ghost of it is left — and then it is simply gone, with
      // the incoming already running underneath at full strength. It works because the incoming
      // was cued to arrive at its own body section, so the moment the outgoing vanishes the new
      // track is at its first real downbeat rather than somewhere in an intro.
      const collapse = clamp(p / 0.8, 0, 1);
      live.setEqLow(lerp(0, EQ_KILL, clamp(p / 0.4, 0, 1)));
      live.setFilter(lerp(0, 0.95, collapse * collapse)); // accelerating — it falls away, not fades
      live.setEqHigh(lerp(0, -8, collapse));
      // THE BUILD. A stepped loop-roll — one bar, then a half, then a beat — is how a DJ tightens
      // the last bar before a cut: the outgoing eats its own tail while the filter climbs, and the
      // drop lands into the space it leaves. Halving on a schedule rather than a timer keeps it on
      // the grid, and `rollBeats` makes each step fire once instead of every tick.
      this.loopRoll(live, rollLadder(p, 0.62, this.transitionBeats()));
    } else if (this.plan.style === "washOut") {
      // THE WASH. The outgoing swells into a big reverb and its dry signal is pulled out from
      // under it, so the track evaporates rather than fades. Where echoOut is rhythmic (tempo-
      // locked repeats you can still count), this one is atmospheric — it works on a pair whose
      // tempos do NOT agree, which is exactly when a beatmatched blend is the wrong idea.
      const rev = this.borrowedFx?.saved.find((x) => x.device.kind === "reverb")?.device;
      const wet = clamp((p - 0.1) / 0.5, 0, 1);
      rev?.setParam("mix", wet * 0.8);
      live.setEqLow(lerp(0, EQ_KILL, clamp(p / 0.35, 0, 1))); // lows go first — never two bass lines
      live.setFilter(lerp(0, 0.7, wet)); // the dry body thins as the wet swells
      // A freeze on the tail turns the last swell into a pad the incoming walks in over — thrown
      // ON THE DOWNBEAT of the last two bars, not at whatever fraction happens to be near it.
      if (barsLeft(p, this.plan.bars) <= 2) rev?.setParam("freeze", 1);
    } else if (this.plan.style === "gateChop") {
      // THE GATE CHOP. The outgoing is cut into tempo-synced slices that get deeper as it leaves,
      // so it stops sounding like a track being faded and starts sounding like a rhythmic device
      // being played. Depth ramps rather than switching, which is what keeps it musical.
      const gate = this.borrowedFx?.saved.find((x) => x.device.kind === "gate")?.device;
      gate?.setParam("depth", clamp(p / 0.7, 0, 1) * 0.9);
      // Tighten the slicing as it goes: 1/8 → 1/16 for the last phrase. On a bar line, because a
      // rate change landing mid-bar is heard as the gate slipping rather than as a gear change.
      gate?.setParam("rate", barsLeft(p, this.plan.bars) <= 4 ? 0.5 : 0.25);
      live.setEqLow(lerp(0, EQ_KILL, clamp(p / 0.45, 0, 1)));
      live.setFilter(lerp(0, 0.6, clamp((p - 0.4) / 0.6, 0, 1)));
    } else if (this.plan.style === "loopChop") {
      // THE LOOP CHOP — the classic build, and the one gesture here that needs NO effect and NO
      // stems: the outgoing is caught in a loop that halves (1 bar → 1/2 → 1 beat) while a filter
      // climbs over it, and the incoming rises underneath. It is pure loop engine + one knob, so
      // it is available on any pair with a beatgrid, which is most of them.
      this.loopRoll(live, rollLadder(p, 0.38, this.transitionBeats()), false);
      live.setFilter(lerp(0, 0.85, clamp((p - 0.4) / 0.5, 0, 1)));
      live.setEqLow(lerp(0, EQ_KILL, clamp((p - 0.3) / 0.4, 0, 1)));
    } else if (this.plan.style === "echoOut") {
      // THE ECHO OUT. The outgoing's last phrase is thrown into the delay and its own dry signal
      // is pulled out from under it, so the track dissolves into its own repeats while the
      // incoming walks in clean. The throw itself is set up in beginEchoThrow; here we take the
      // dry level away and let the wet tail carry.
      const wet = clamp((p - 0.25) / 0.45, 0, 1);
      const dly = this.borrowedFx?.saved.find((x) => x.device.kind === "delay")?.device;
      dly?.setParam("mix", wet * 0.75);
      live.setEqLow(lerp(0, EQ_KILL, clamp(p / 0.35, 0, 1))); // lows go first — never two bass lines
      live.setEqHigh(lerp(0, -6, wet));
      live.setFilter(lerp(0, 0.5, wet));
      // Freeze the repeats at the end: the outgoing is gone but its last phrase keeps ringing over
      // the incoming, which is the whole point of throwing it in the first place. On the downbeat
      // of the last two bars — a delay freezing off the grid smears the very thing it captured.
      if (barsLeft(p, this.plan.bars) <= 2) dly?.setParam("freeze", 1);
    } else if (this.plan.style === "spinOut") {
      // THE SPIN OUT. A clash that no blend can fix, made deliberate: the outgoing keeps its full
      // body right up to the last bar and is then spun down (fired once, at the trigger point) as
      // the incoming lands on its "1". Everything before that is just holding steady.
      if (!this.spinFired && p >= 0.72) {
        this.spinFired = true;
        live.spinback();
      }
      live.setEqLow(lerp(0, EQ_KILL, clamp((p - 0.6) / 0.4, 0, 1)));
    } else if (this.plan.style === "filter") {
      // Cheap one-knob filter sweep: incoming opens from a low-pass; the outgoing
      // leaves through a high-pass in the back half. Bass still swaps so lows don't
      // stack. The filter masks an unproven pairing — sounds deliberate.
      live.setFilter(lerp(0, 0.85, clamp((p - 0.45) / 0.55, 0, 1)));
      live.setEqLow(lerp(0, EQ_KILL, s));
    } else {
      // EQ3 blend: bass swap, plus duck the OUTGOING highs in the last third so the
      // hats/cymbals don't clash on the way out — a 3-band handover, not just lows.
      live.setEqLow(lerp(0, EQ_KILL, s));
      live.setEqHigh(lerp(0, -10, clamp((p - 0.6) / 0.4, 0, 1)));
      // Contextual one-knob filter motion layered on the EQ: the INCOMING slides in from
      // under a gentle low-pass over the first half, the OUTGOING ghosts out through a
      // rising high-pass over the back half — HP/LP follow whichever deck is leaving vs
      // entering. Subtler than the dedicated "filter" style; the EQ does the heavy lift.
      live.setFilter(lerp(0, 0.6, clamp((p - 0.5) / 0.5, 0, 1)));
    }
    // …and the INCOMING half, once, for every gesture — see applyEntry.
    if (!this.useStems) this.applyEntry(inc, p, s);

    // Flourishes ride ON TOP of whatever gesture just ran, so they go last — a lift written before
    // the style's own setEqHigh would simply be overwritten.
    this.microPerform(live, inc, p);
    // The stutter window: a fast tremolo on the outgoing's filter, driven off transition progress
    // (not a timer) so pausing freezes it along with everything else.
    if (this.mixElapsed < this.stutterUntil) {
      const phase = Math.sin(this.mixElapsed * Math.PI * 16); // ~8 Hz — a bar of 16ths at 120bpm
      live.setFilter(clamp(0.55 + 0.45 * phase, 0, 1));
    }

    // Done when the ramp finishes, the outgoing track runs out, or the user kills
    // the outgoing deck (a deliberate "drop the old track" move → finish on incoming).
    if (p >= 1 || (live.duration && live.position() >= live.duration - 0.1) || !live.playing) this.settle();
  }

  // ── THE INCOMING HALF OF THE TRANSITION ──────────────────────────────────────────────────────
  //
  // Every gesture above spends its lines on the OUTGOING deck. What each one used to do to the
  // incoming deck was one or two lines tacked on the end of its branch, and because it lived
  // inside the branch it could never be chosen independently — "filter the old one out" and
  // "drop the new one in on its downbeat" were welded into a single decision.
  //
  // These are those lines, lifted out unchanged and given names. `resolveEntry` maps each style
  // back to the one it always had, so the default path is bit-for-bit what it was; the two new
  // entries (dropIn, riseIn) are the moves that were previously unreachable.
  //
  // Not called for a stem swap: that gesture hands over stem by stem on both decks at once, and
  // an EQ/filter ramp layered on top would fight its own handover.
  private applyEntry(inc: Deck, p: number, s: number): void {
    const r = entryRamp(this.plan?.entry ?? "open", p, s, this.plan?.bars ?? 0);
    if (r.filter != null) inc.setFilter(r.filter);
    inc.setEqLow(r.eqLow);
  }

  // The user took over the crossfader mid-mix: neutralise the half-applied EQ/stems,
  // release locks, stop driving, and wait for them to land on a single deck.
  private handoffToManual(): void {
    if (this.liveId) {
      const idle = other(this.liveId);
      this.neutralizeDeck(this.liveId);
      this.neutralizeDeck(idle);
      this.releaseLocks(idle);
      this.endGlide(); // restore keylock; leave tempo where it is (keep the beatmatch)
    }
    this.cuedIdle = null;
    this.useStems = false;
    this.returnFx(); // borrowed FX devices must never outlive the transition
    this.endVocalTail(); // …and neither may an AUTO-owned chain
    this.releaseHoldLoop();
    this.spinFired = false;
    this.stutterFired = false;
    this.stutterUntil = 0;
    this.mixStarted = false;
    this.plan = null;
    this.mixOutTime = null;
    this.quietGpuEnd();
    this.phase = "manual";
  }

  private tickManual(): void {
    const a = this.deps.engine.deck("A").playing;
    const b = this.deps.engine.deck("B").playing;
    if (!a && !b) {
      this.liveId = null;
      this.liveVideoId = null;
      this.resetArm();
      this.phase = "idle";
      return;
    }
    if (a !== b) {
      // Exactly one deck left → adopt it as the new live deck and re-arm.
      this.liveId = a ? "A" : "B";
      this.liveVideoId = this.deps.deckTrack(this.liveId)?.videoId ?? null;
      this.deps.queue.setCurrent(this.deps.deckTrack(this.liveId));
      this.resetArm();
      this.phase = "armed";
    }
    // Both still playing → the user is mixing; keep waiting.
  }

  private settle(): void {
    if (!this.liveId) {
      this.phase = "idle";
      return;
    }
    const idle = other(this.liveId);
    const out = this.deps.engine.deck(this.liveId);
    const inc = this.deps.engine.deck(idle);
    const sign = idle === "A" ? -1 : 1;
    this.deps.applyCrossfade(sign);
    this.lastXfade = sign;
    // The incoming deck becomes live — neutralise everything we touched on it.
    inc.setEqLow(0);
    inc.setEqHigh(0);
    inc.setFilter(0);
    inc.resetStems();
    out.pause();
    this.neutralizeDeck(this.liveId);
    this.releaseLocks(idle);
    this.endGlide(); // restore keylock on both decks (was dropped for the vinyl glide)
    // The outgoing was the glide MASTER — its tempo got ramped toward the incoming's BPM.
    // It's paused now (silent), so reset it cleanly back to natural for its next use.
    out.setTempo(0);
    out.setPitch(0);
    // The incoming deck is now live ON ITS OWN — return it to natural tempo + key.
    // The SYNC/KEY bend only existed to beatmatch + harmonically blend it WITH the
    // outgoing track; releasing the lock doesn't undo the tempo/pitch it applied, so
    // without this the new track stays stuck up-tempo'd / shifted in the wrong key.
    // (After the glide the incoming is already at ~natural BPM, so this is seamless.)
    inc.setTempo(0);
    inc.setPitch(0);
    this.useStems = false;
    this.returnFx(); // borrowed FX devices must never outlive the transition
    this.endVocalTail(); // …and neither may an AUTO-owned chain
    this.releaseHoldLoop();
    this.spinFired = false;
    this.stutterFired = false;
    this.stutterUntil = 0;
    this.deps.queue.advance();
    this.advancedByAuto(); // AUTO mixed this one in — age the anchor, move along the arc
    this.liveId = idle;
    this.liveVideoId = this.nextTrack?.videoId ?? this.deps.deckTrack(idle)?.videoId ?? null;
    this.deps.queue.setCurrent(this.nextTrack);
    this.cuedIdle = null;
    this.nextTrack = null;
    this.plan = null;
    this.mixOutTime = null;
    this.mixStarted = false;
    this.mixElapsed = 0;
    // The mix is over and the screen is calm again — let deferred separations run. Released
    // BEFORE clearPreload/armed on purpose: the very next armed tick starts the next track's
    // load, and that load wants the GPU free the instant it asks for it.
    this.quietGpuEnd();
    // The deck we just blended in is now live; the OUTGOING deck is the new idle. Forget the
    // old preload so the next armed tick eagerly loads the next-next track onto it.
    this.clearPreload();
    this.phase = "armed";
  }

  private releaseLocks(idle: DeckId): void {
    const engine = this.deps.engine;
    if (engine.syncRole(idle) === "slave") engine.toggleSync(idle);
    if (engine.keyRole(idle) === "slave") engine.toggleKey(idle);
  }

  // The deck's structure, in the shape mixPoints.ts wants. Guards the loudness bounds the way the
  // old inline code did: `lastSound` is only trusted when it lands in the back half (a quiet track
  // can produce a bogus early bound, and mixing out at 20% because of it is a skip, not a mix).
  private sectionsOf(deck: Deck): Sections | null {
    const dur = deck.duration;
    if (!dur) return null;
    const grid = deck.beatgrid;
    const lastSound = grid?.lastSound && grid.lastSound > dur * 0.5 ? grid.lastSound : dur;
    return {
      starts: grid?.phrases ? Array.from(grid.phrases) : [],
      labels: grid?.phraseLabels ?? [],
      firstSound: grid?.firstSound ?? 0,
      lastSound,
      duration: dur,
    };
  }

  // WHERE TO LEAVE. Structure-aware (chooseMixOut prefers the end of the final chorus); the
  // result is snapped to the grid here, because a mix that starts off-beat is audibly wrong
  // however musically apt the moment was.
  private computeMixOut(deck: Deck, barsSeconds: number): number {
    const s = this.sectionsOf(deck);
    if (!s) return 0;
    const t = chooseMixOut(s, barsSeconds, END_GUARD);
    const grid = deck.beatgrid;
    return grid ? nearestBeat(grid, t) : t;
  }

  // WHERE TO COME IN. Anchored so the incoming track's first BODY section — the first one that
  // recurs later, i.e. the point past the intro where the track really starts — lands at the END
  // of the blend, with its intro riding under the outgoing track's outro.
  private computeMixIn(deck: Deck, barsSeconds: number): number {
    const grid = deck.beatgrid;
    if (!grid) return 0;
    const s = this.sectionsOf(deck);
    if (!s) return 0;
    const firstBeat = grid.firstBeat ?? 0;
    const baseDown =
      grid.beats && grid.beats.length && grid.downbeat != null ? grid.beats[grid.downbeat] ?? firstBeat : firstBeat;
    const t = chooseMixIn(s, barsSeconds, baseDown);
    return t <= baseDown ? baseDown : Math.max(baseDown, nearestBeat(grid, t));
  }

  // Raise / lower the GPU quiet window. Raising twice is a no-op (one hold per transition); the
  // release is safe to call from any exit path, including ones that never cued.
  // The track after next, if the queue knows one. Deliberately reads `upcoming[1]` rather than
  // tracking its own cursor: `upcoming[0]` is what ensurePreload is already loading onto the idle
  // deck, so [1] is the first track NOTHING else is working on.
  // What the SET is doing, for the gesture chooser. The arc is the user's stated intent; the lift
  // is what these two particular records do to the energy. Lift is null unless BOTH are analysed —
  // an unanalysed pair is not a flat one, and reporting 0 would apply the wind-down bias to every
  // track the analysis hasn't reached yet.
  private styleShape(idle: DeckId): StyleShape {
    const outE = this.liveId ? this.deps.deckTrack(this.liveId)?.energy : null;
    const incE = this.deps.deckTrack(idle)?.energy;
    const known = outE != null && Number.isFinite(outE) && incE != null && Number.isFinite(incE);
    return { arc: this.deps.queue.arc, lift: known ? (incE as number) - (outE as number) : null };
  }

  private warmAhead(): void {
    if (!this.deps.warmStems) return;
    const after = this.deps.queue.upcoming[1];
    const vid = after?.videoId;
    if (!vid || vid === this.warmedId) return;
    this.warmedId = vid;
    this.deps.warmStems(vid);
  }

  /** The blend's length in beats — what a loop ladder is actually measured in. */
  private transitionBeats(): number {
    return Math.max(1, (this.plan?.bars ?? 0) * BEATS_PER_BAR);
  }

  private quietGpuStart(): void {
    if (this.gpuQuiet) return;
    this.gpuQuiet = holdGpu();
    event("automix.gpu", { at: "quiet" });
  }
  private quietGpuEnd(): void {
    if (!this.gpuQuiet) return;
    this.gpuQuiet();
    this.gpuQuiet = null;
    event("automix.gpu", { at: "resume" });
  }

  private emit(force: boolean): void {
    const s = this.getStatus();
    const key = `${s.enabled}|${s.phase}|${s.liveDeck}|${s.plan?.style ?? ""}|${Math.round(s.countdownSec ?? -1)}`;
    if (!force && key === this.lastEmitKey) return;
    this.lastEmitKey = key;
    this.deps.onChange(s);
  }
}

/** The incoming deck's shaping at transition progress `p` (0..1), with `s` the plan's bass-swap
 *  ramp. `filter: null` means "write nothing" — the historical `open` behaviour touched only EQ.
 *
 *  Pure and exported so the ramps can be asserted directly: the FakeDeck in the machine tests has
 *  always had no-op setEqLow/setFilter, so a transition's incoming shaping was invisible to the
 *  whole suite. Extracting the entries from the style branches would have been unverifiable
 *  otherwise — the tests would have gone green whatever these numbers said. */
export function entryRamp(
  entry: TransitionEntry,
  p: number,
  s: number,
  bars = 0,
): { filter: number | null; eqLow: number } {
  switch (entry) {
    // The blend's arrival: in from under a gentle low-pass over the first half, bass on the plan's
    // swap schedule.
    case "sweep":
      return { filter: lerp(-0.55, 0, clamp(p / 0.5, 0, 1)), eqLow: lerp(EQ_KILL, 0, s) };
    // The filter style's arrival: further down, and opening across the WHOLE blend.
    case "sweepWide":
      return { filter: lerp(-0.85, 0, p), eqLow: lerp(EQ_KILL, 0, s) };
    // Sits under the outgoing's tightening loop and opens as it does. Bass is already free — the
    // loop chop kills the outgoing low separately, so there is nothing to swap with.
    case "underLoop":
      return { filter: lerp(-0.5, 0, clamp(p / 0.6, 0, 1)), eqLow: 0 };
    // ★ THE ARRIVAL AS THE EVENT. Held back — bass killed, well under a low-pass, and NOT creeping
    // open, so the ear stops expecting it — then released hard over the last fifth. Paired with a
    // gesture that collapses the outgoing, this is what makes the new track land in a hole rather
    // than emerge from a fade. It only reads as a drop because the incoming was cued to its own
    // body section: what lands is a real downbeat.
    case "dropIn": {
      // ★ RELEASED OVER THE LAST TWO BARS, not the last fifth. This is the most timing-critical
      // moment in the whole system — the gesture exists to make the incoming track LAND — and a
      // fifth of the transition is a different number of bars on every blend, so the release
      // opened mid-bar as often as not. Two bars is a phrase-relative instruction: the same
      // musical gesture at any tempo or blend length. `bars` unknown (0) falls back to the
      // fraction, which is what every non-drop entry uses anyway.
      const window = bars > 0 ? Math.min(2, bars / 4) : 0;
      const release = window > 0 ? clamp(1 - barsLeft(p, bars) / window, 0, 1) : clamp((p - 0.8) / 0.2, 0, 1);
      return { filter: lerp(-0.8, 0, release), eqLow: lerp(EQ_KILL, 0, release) };
    }
    // ★ THE OPPOSITE. A long swell with the low end arriving late, so the incoming grows into the
    // room instead of turning up in it — for a wind-down, where a clean arrival would sound like
    // the set restarting.
    case "riseIn":
      return { filter: lerp(-0.9, 0, p), eqLow: lerp(EQ_KILL, 0, clamp((p - 0.45) / 0.55, 0, 1)) };
    default:
      return { filter: null, eqLow: 0 }; // "open" — just arrive
  }
}

// ── THE LOOP-ROLL ACCELERANDO ──────────────────────────────────────────────────────────────────
//
// The oldest trick there is: catch the outgoing track in a loop and halve it — two bars, one bar,
// half a bar, one beat — so the last stretch of the transition tightens into the new track. It
// needs no effect and no stems, only a beatgrid, which is why it is available on nearly every pair.
//
// Two things the old inline ladders got wrong.
//
// ★ THE RUNGS WERE FIXED WHILE THE BLEND WAS NOT. `p >= 0.9 ? 1 : p >= 0.8 ? 2 : p >= 0.7 ? 4 : 0`
// spends a fixed FRACTION of the transition on each rung, but a loop is measured in BEATS. On a
// 32-bar blend that gives a 4-beat loop about 13 beats — it repeats three times and stops being a
// build. On an 8-bar blend the same rung gets three beats: the loop is cut off before it has
// played once, which does not read as a loop at all, just a glitch. So each rung is allocated
// exactly its OWN length in beats — the 8-beat rung plays for 8 beats — and the ladder starts from
// whichever rung actually fits the runway available. A short blend simply begins later, at 2 beats.
//
// ★ AND IT WAS RELEASED LATE. The roll used to run until settle, which fires on the first 150 ms
// tick at or after p = 1. On a one-beat loop at 128 bpm a tick is a third of the loop, so the
// release landed anywhere up to a third of a beat INTO the new track — audible, and exactly the
// wrong kind of audible: a stutter over the downbeat everything else was aimed at. Releasing a
// hair EARLY is inaudible; releasing late is the whole gesture missing its landing. So the ladder
// returns 0 just before the end and the loop is out before the downbeat arrives.
const ROLL_RUNGS = [8, 4, 2, 1] as const;
const ROLL_RELEASE = 0.985; // exit here, not at 1 — see above

/** Loop length in beats at transition progress `p`, or 0 for "not looping".
 *  `start` is where the ladder begins; `transitionBeats` is how long the whole blend is. */
export function rollLadder(p: number, start: number, transitionBeats: number): number {
  if (p < start || p >= ROLL_RELEASE) return 0;
  const span = ROLL_RELEASE - start;
  if (span <= 0 || !(transitionBeats > 0)) return 0;
  const runway = span * transitionBeats;
  // Drop rungs from the TOP until the ladder fits: a short blend starts tight rather than
  // starting long and truncating. At least one rung always survives.
  let rungs: readonly number[] = ROLL_RUNGS;
  const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
  while (rungs.length > 1 && sum(rungs) > runway) rungs = rungs.slice(1);
  const ladder = sum(rungs);
  // ★ MEASURED BACKWARDS FROM THE RELEASE, not forwards from `start`. Spreading the rungs across
  // the available runway — the obvious way, and the first way this was written — scales every rung
  // by runway/ladder, so on a long blend the "one beat" rung is held for two and a half beats and
  // the accelerando is not an accelerando at all, just four loops of the wrong lengths. Anchoring
  // at the end instead gives every rung exactly its own beats, so each loop plays through once and
  // the halving is real. `start` becomes what it should always have been: a NOT-BEFORE bound.
  const beatsLeft = (ROLL_RELEASE - p) * transitionBeats;
  if (beatsLeft > ladder) return 0; // the ladder has not begun yet
  let acc = 0;
  for (let i = rungs.length - 1; i >= 0; i--) {
    acc += rungs[i];
    if (beatsLeft <= acc) return rungs[i];
  }
  return rungs[0];
}

// ── PHRASE-LOCKING THE EFFECTS ─────────────────────────────────────────────────────────────────
//
// The continuous ramps — a reverb swelling, a filter climbing — are right to ride `p`: they are
// gestures with no moment in them, and quantising them would just make them steppy.
//
// The DISCRETE events are the problem. A delay freezing, a gate doubling its rate, a held-back
// track being released: those are moments, and a moment either lands on a bar line or it sounds
// like a mistake. They were all written as fractions of the transition — `p > 0.82`, `p > 0.85`,
// `p > 0.66` — which means the bar they land on depends on how long the blend happens to be. On a
// 12-bar blend `p > 0.82` is bar 9.84: the freeze arrives most of a beat after the downbeat, which
// is exactly where the ear hears it as late rather than as a decision.
//
// Counting in BARS REMAINING fixes it, and does so for free: the blend's length is chosen by
// blendBarsFor and its start by chooseMixOut, both of which work off the outgoing track's phrase
// structure. So a bar line inside the transition is already a bar line in the music, and "the last
// two bars" is a phrase-relative instruction on every pair, whatever the tempo or the length.
export function barsLeft(p: number, bars: number): number {
  return Math.max(0, (1 - p) * Math.max(1, bars));
}

export type StemGains = { drums: number; bass: number; vocals: number; other: number };

/** Both decks' stem gains at transition progress `p`, with `s` the bass-swap ramp.
 *
 *  THE STANDARD SWAP is arrangement-aware rather than a bass trade:
 *   • DRUMS + BASS swap around bassSwapBar — only one low end at a time, always.
 *   • VOCALS hand off with a GAP: the outgoing ducks out by mid-blend, the incoming lands late,
 *     so two lead vocals never sit at full together.
 *   • OTHER (melody/harmony) crossfades — long when the pair is key-matched, tight when it is
 *     not, because stacking two dissonant melodies is the thing to avoid.
 *
 *  ★ THE ACAPELLA HOLD is the move a person makes and a crossfader cannot. Everything else of the
 *  outgoing track is taken away EARLY — drums, bass, and melody are gone by the time the incoming
 *  bed is established — and its VOCAL is held, alone, over the new track, for the middle of the
 *  blend. Then it steps aside and the incoming's own vocal arrives in the space.
 *
 *  It is gated on a KNOWN key match at the call site, and that gate is the whole thing: a lead
 *  vocal held over a bed in an unrelated key is the exact way this move goes wrong, and it goes
 *  wrong loudly. Unknown is not permission — see the `acapella` flag in startMix.
 *
 *  Pure and exported for the same reason as entryRamp: the FakeDeck's setStemGain records nothing,
 *  so nothing about a stem swap's envelope was ever observable from a test. */
export function stemBlend(
  p: number,
  s: number,
  opts: { keyMatch: boolean; acapella: boolean },
): { live: StemGains; inc: StemGains } {
  const rhythmOut = lerp(1, 0, s);
  const rhythmIn = lerp(0, 1, s);

  if (opts.acapella) {
    // Clear the outgoing bed early and bring the incoming's in to replace it, so that by ~45%
    // there is exactly ONE instrumental playing and one voice over it.
    const bedOut = clamp(p / 0.45, 0, 1);
    const bedIn = clamp(p / 0.4, 0, 1);
    // The vocal holds FLAT — no creep, or it turns into an ordinary fade — then leaves over a
    // short window, and the incoming's own vocal starts only after it has gone.
    const held = lerp(1, 0, clamp((p - 0.72) / 0.16, 0, 1));
    return {
      live: { drums: lerp(1, 0, bedOut), bass: lerp(1, 0, bedOut), other: lerp(1, 0, bedOut), vocals: held },
      inc: { drums: bedIn, bass: bedIn, other: bedIn, vocals: clamp((p - 0.9) / 0.1, 0, 1) },
    };
  }

  const km = opts.keyMatch;
  const incOther = km ? clamp((p - 0.4) / 0.5, 0, 1) : clamp((p - 0.45) / 0.2, 0, 1);
  const liveOther = km ? clamp((p - 0.55) / 0.45, 0, 1) : clamp((p - 0.5) / 0.2, 0, 1);
  return {
    live: {
      drums: rhythmOut,
      bass: rhythmOut,
      // Disjoint vocal windows: outgoing out over [0, 0.45], incoming in over [0.6, 1].
      vocals: lerp(1, 0, clamp(p / 0.45, 0, 1)),
      other: lerp(1, 0, liveOther),
    },
    inc: { drums: rhythmIn, bass: rhythmIn, vocals: lerp(0, 1, clamp((p - 0.6) / 0.4, 0, 1)), other: incOther },
  };
}

export function other(id: DeckId): DeckId {
  return id === "A" ? "B" : "A";
}
export function barsToSeconds(bars: number, bpm: number): number {
  if (!bpm || bpm <= 0) return bars * 2;
  return (bars * BEATS_PER_BAR * 60) / bpm;
}
