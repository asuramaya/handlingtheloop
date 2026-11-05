import type { AudioEngine, DeckId, FxDevice } from "../audio";
import { beatTimeOffset, foldTempoOctave, nearestDownbeat, tempoLockable } from "../analysis";

// (BRIDGE_MAX lives in mixability.ts, next to previewPlan, which needs it too.)

/** THE TEMPO BRIDGE, bar by bar (counted in the live track's own time: with a 1-bar loop every
 *  bar is one pass of the loop). The loop is caught on bar 0's downbeat. */
export const BRIDGE = {
  bars: 8,
  rampEnd: 4, // bars 0-4: the looped bar glides to the incoming's tempo
  roll: [4, 5, 5.5] as const, // the build: the loop halves on each of these bar lines
  breath: 5.75, // the last beat before the drop: dry out, echo frozen — the inhale
  drop: 6, // the incoming lands, on its body section, on the one
};

/** Where the bridge is at bars-elapsed `b` (0..8): the outgoing's shaping, as plain numbers. Pure,
 *  so a test can walk the whole gesture. `tempoT` is the 0..1 smoothstep of the ramp. */
export function bridgeShape(b: number, showy: boolean): {
  tempoT: number;
  filter: number; // outgoing one-knob filter (+ = high-pass)
  eqLow: number; // outgoing low shelf, dB
  delayMix: number;
  reverbMix: number;
  freeze: boolean;
  rollBeats: number; // 0 = leave the base loop alone
  dropped: boolean;
  fader: number; // 0 = outgoing … 1 = incoming
} {
  const ss = (x: number) => {
    const t = clamp(x, 0, 1);
    return t * t * (3 - 2 * t);
  };
  const tempoT = ss(b / BRIDGE.rampEnd);
  const build = clamp((b - BRIDGE.rampEnd) / (BRIDGE.drop - BRIDGE.rampEnd), 0, 1);
  const dropped = b >= BRIDGE.drop;
  const breath = showy && b >= BRIDGE.breath && !dropped;
  let rollBeats = 0;
  if (showy) for (const [i, at] of BRIDGE.roll.entries()) if (b >= at) rollBeats = [2, 1, 0.5][i];
  return {
    tempoT,
    // A slow rise across the ramp, then the climb of the build.
    filter: dropped ? 0.6 : lerp(0, 0.3, tempoT) + lerp(0, showy ? 0.5 : 0.35, build),
    eqLow: dropped ? EQ_KILL : lerp(0, EQ_KILL, build), // the bass is PULLED before the drop
    delayMix: dropped || breath ? 1 : lerp(0, 0.3, tempoT) + lerp(0, 0.3, build),
    reverbMix: lerp(0, 0.2, tempoT) + lerp(0, showy ? 0.35 : 0.2, build),
    freeze: breath || dropped,
    rollBeats,
    dropped,
    // Nothing of the incoming before the drop; on it, the new track all but full and the old one's
    // frozen echo under it, gone by the end.
    fader: dropped ? 0.8 + 0.2 * ss((b - BRIDGE.drop) / (BRIDGE.bars - BRIDGE.drop)) : 0,
  };
}
import type { TrackMeta } from "../library/types";
import { BRIDGE_MAX, bandBars, phraseSwapBar, pickTransition, resolveEntry, resolveStyle, transitionLabel, type StyleShape } from "./mixability";
import { type Sections, blendBarsFor, chooseMixIn, chooseMixOut, firstBodySection, phraseBars } from "./mixPoints";
import type { AutoMixPhase, AutoMixWaitReason, MixMode, RadioContext, StyleCapabilities, TransitionEntry, TransitionPlan, TransitionStyle } from "./types";
import type { FxKind } from "../audio";
import type { AutoFxSettings, AutoPerformance } from "../state/settings";
import type { MixQueue } from "./queue";
import { clamp, lerp } from "../../util/math";
import { event } from "../debug/trace";
import { perfWork } from "../debug/perfCapture";
import { crossfadeGains } from "../audio/crossfadeCurve";
import { holdGpu } from "../stems/gpuQueue";
import { DD, DD_BARS, doubleDropShape, planDoubleDrop } from "./doubleDrop";

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
// A live-deck position change this much off what playback explains (s) is the user MOVING the
// track — SHIFT-search, a seek, a hot cue, a long scratch — and the mix point is re-planned from
// where they landed. Ordinary playback, pitch bend and a scratch wiggle stay far below it.
const JUMP_S = 2;
// How far ahead of the playhead a re-planned exit must be while armed: the next track still has
// to load and cue before the blend can start.
const CUE_LEAD_S = 8;

// PLAYING, COUNTING THE HAND. Gripping a platter stops the transport (JogEngine.scrubBegin — a
// hand on vinyl stops it dead) and releasing it starts it again. To the mixer that grab used to
// read as the user STOPPING the deck: touch the incoming deck's jog mid-blend and AUTO handed the
// whole transition to "manual"; touch the outgoing one near its exit and the mix started under
// your hand. A deck that will play again the moment the hand lets go is still a playing deck.
// `jogReturnsToPlay` is false for a paused deck being scrubbed, so cueing a stopped deck by hand
// is not mistaken for starting it.
function playingOrHeld(d: Deck): boolean {
  return d.playing || (!!d.jogging && !!d.jogReturnsToPlay);
}
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
  /** The transition: proposed at preload (from metadata), RESOLVED at mix start (the gesture that
   *  actually plays — see planResolved). null until the next track is cued. */
  plan: TransitionPlan | null;
  /** Seconds into the LIVE track where the mix starts. Set from the first playing armed tick. */
  mixOutTime: number | null;
  /** Before the mix: seconds until it starts. During the mix: seconds until it ends. */
  countdownSec: number | null;
  // ── added for the status UI. Optional ONLY because a session mirror can come from an older host;
  //    this mixer always fills every one of them. ──
  /** "Hold on this track": no automatic transition starts until Hold is pressed again or Mix now.
   *  A natural track end still continues onto the next track. Cleared when the live track changes. */
  held?: boolean;
  /** What AUTO is waiting on, if anything (see AutoMixWaitReason). */
  waitReason?: AutoMixWaitReason;
  /** 0..1 through the transition while phase === "mixing"; null otherwise. */
  mixProgress?: number | null;
  /** Length (s) of the live track, so mixOutTime can be drawn on it. */
  liveDuration?: number | null;
  /** The next track once it sits loaded on the idle deck. */
  nextOnDeck?: { deck: DeckId; videoId: string } | null;
  /** Short label of `plan` ("Blend 16", "Echo 8"…); null without a plan. */
  planLabel?: string | null;
  /** True once the plan is the gesture actually being performed (set at mix start). */
  planResolved?: boolean;
  /** The user took the crossfader mid-mix; AUTO stands back until one deck is left. */
  manual?: boolean;
  /** Mix now was pressed and the mix will start as soon as the incoming deck is ready. */
  forced?: boolean;
}

/** The status of a mixer that has never been enabled — a starting value for UI state. */
export const IDLE_AUTOMIX_STATUS: AutoMixStatus = {
  enabled: false,
  phase: "idle",
  liveDeck: null,
  plan: null,
  mixOutTime: null,
  countdownSec: null,
  held: false,
  waitReason: null,
  mixProgress: null,
  liveDuration: null,
  nextOnDeck: null,
  planLabel: null,
  planResolved: false,
  manual: false,
  forced: false,
};

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
  private unlocked = false; // this transition's pair cannot be beat-matched (caps.lock false)
  private fineTimer: ReturnType<typeof setInterval> | null = null; // the 16 ms loop around a moment
  private bridge: { baseBeats: number; fromPct: number; toPct: number; keylock: boolean } | null = null;
  // A double drop planned while armed (the incoming is already decoded on the idle deck): the
  // videoId it was planned for, and the cue points — taken at preload only if still the next track.
  private dd: { videoId: string; mixOut: number; mixIn: number } | null = null;
  private ddChecked = "";
  private ddDropped = false;
  private incPending = false; // unmatched pair: the incoming starts at the cut, not at mix start
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
  // ── control state ──
  private ticking = false; // tick() is NOT re-entrant: the 150 ms interval never overlaps a slow tick
  private held = false; // Hold toggle — see AutoMixStatus.held
  private forced = false; // Mix now — preload/cue keep the mix point at "now"
  private kickoffPlay = false; // set by enable(): the AUTO press may start a loaded, stopped deck ONCE
  private stemHold = false; // cueing is holding at the mix point for stems (status only)
  private planResolved = false;
  // THE IDLE DECK'S TRACK — may AUTO overwrite it? Holds, per deck, the videoId AUTO is free to
  // replace: a track AUTO loaded itself, or one that has already been the live track. Anything
  // else sitting on the idle deck was put there by the user, and protectIdle queues it instead of
  // loading over it.
  private claimable: Record<DeckId, string | null> = { A: null, B: null };

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
    this.held = false;
    this.forced = false;
    if (this.liveId) {
      this.claimable[this.liveId] = this.liveVideoId;
      if (!this.deps.queue.getCurrent()) this.deps.queue.setCurrent(this.deps.deckTrack(this.liveId));
    }
    // Nothing playing → the AUTO press itself is the "go": the first idle tick may START a loaded,
    // stopped deck (tryKickoff). One-shot — after a pause, or a manual stop of both decks, AUTO
    // never force-starts a deck again; it waits (waitReason "press-play").
    this.kickoffPlay = !this.liveId;
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
    this.held = false;
    this.forced = false;
    this.kickoffPlay = false;
    this.phase = "idle";
    this.emit(true);
  }

  /** MIX NOW — honoured from any pre-mix phase, and clears Hold. From armed it goes straight
   *  through preload and cueing; the mix starts as soon as the incoming deck is loaded (and, for a
   *  bounded moment, its stems). `forced` makes preload keep the mix point at "now" instead of
   *  recomputing the structural exit — which is what used to swallow the press. */
  mixNow(): void {
    if (!this.enabled) return;
    this.held = false;
    if (this.liveId && (this.phase === "armed" || this.phase === "preload" || this.phase === "cueing")) {
      this.forced = true;
      this.mixOutTime = this.deps.engine.deck(this.liveId).position();
      if (this.phase === "armed") this.phase = "preload";
      this.emit(true);
      void this.tick();
      return;
    }
    this.emit(true);
  }

  /** SKIP — drop the track that would be mixed in next: the cued `nextTrack`, else the preloaded
   *  one, else the queue head. Mid-mix it aborts the transition first, exactly like cancel
   *  (incoming paused, crossfader back on the live deck, locks released). The idle deck held a track
   *  AUTO loaded, so the next armed tick preloads the new head over it. */
  skip(): void {
    if (!this.enabled) return;
    const target = this.nextTrack ?? this.preloadedTrack ?? this.deps.queue.peekNext();
    this.cancel(); // bumps gen → an in-flight load of the skipped track is discarded
    if (target?.videoId) this.deps.queue.remove(target.videoId);
    this.emit(true);
  }

  /** HOLD — a toggle: "stay on this track". While held no automatic transition starts; a natural
   *  track end still continues onto the next track, so the music never stops. Pressed during a
   *  transition it aborts the mix and keeps the incoming track queued. Pressing it again, or Mix
   *  now, releases it; so does the live track changing. */
  hold(): void {
    if (!this.enabled) return;
    if (this.held) {
      this.held = false;
      this.emit(true);
      return;
    }
    this.held = true;
    if (this.phase === "preload" || this.phase === "cueing" || this.phase === "mixing") this.cancel();
    else this.emit(true);
  }

  isHeld(): boolean {
    return this.held;
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
      this.cuedIdle = null; // handled above — a later abandonCue must not neutralise it twice
    } else {
      this.abandonCue();
    }
    this.useStems = false;
    this.unlocked = false; // the cut-on-the-one state ends with the transition, however it ends
    this.incPending = false;
    this.stopFine();
    this.endBridge();
    this.dd = null;
    this.ddChecked = "";
    this.ddDropped = false;
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
    // `preloading` is deliberately NOT cleared here. It is the in-flight guard of an async load and
    // is released by that load's own `finally`; clearing it from a skip/cancel let a second load
    // start onto the same deck while the first was still landing.
    this.forced = false;
    this.stemHold = false;
    this.planResolved = false;
    this.mixStarted = false;
    this.mixElapsed = 0;
    this.plan = null;
    this.mixOutTime = null;
    this.nextTrack = null;
    this.clearPreload();
    this.dd = null; // a planned double drop belongs to THIS live track and THAT preload
    this.ddChecked = "";
    this.ddDropped = false;
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
    const live = this.liveDeck();
    const mixing = this.phase === "mixing";
    return {
      enabled: this.enabled,
      phase: this.phase,
      liveDeck: this.liveId,
      plan: this.plan,
      mixOutTime: this.mixOutTime,
      countdownSec: this.countdown(),
      held: this.held,
      waitReason: this.waitReason(),
      mixProgress: mixing ? this.mixProgress() : null,
      liveDuration: live && live.duration > 0 ? live.duration : null,
      nextOnDeck: this.nextOnDeck(),
      planLabel: this.plan ? transitionLabel(this.plan) : null,
      planResolved: this.planResolved,
      manual: this.phase === "manual",
      forced: this.forced,
    };
  }

  private mixProgress(): number {
    return clamp(this.mixElapsed / Math.max(0.001, this.barsSeconds), 0, 1);
  }

  // Before the mix: seconds to the mix point. During it: seconds of blend left.
  private countdown(): number | null {
    if (!this.liveId) return null;
    if (this.phase === "mixing") return Math.max(0, this.barsSeconds * (1 - this.mixProgress()));
    if (this.mixOutTime == null) return null;
    if (this.phase !== "armed" && this.phase !== "preload" && this.phase !== "cueing") return null;
    const live = this.deps.engine.deck(this.liveId);
    // Track seconds ÷ tempo = seconds you will actually wait (at +8 % a 60 s gap is 55.6 s).
    return Math.max(0, (this.mixOutTime - live.position()) / (live.rate > 0 ? live.rate : 1));
  }

  // The next track, once it is actually sitting on the idle deck.
  private nextOnDeck(): { deck: DeckId; videoId: string } | null {
    if (!this.liveId) return null;
    const idle = other(this.liveId);
    const onDeck = this.deps.deckTrack(idle)?.videoId;
    const want = this.nextTrack?.videoId ?? (this.preloadedId === idle ? this.preloadedTrack?.videoId : undefined);
    return want && onDeck === want ? { deck: idle, videoId: want } : null;
  }

  // WHY NOTHING IS MOVING — derived from the machine's own state every time, never latched, so it
  // can't go stale. Ordered most-specific first.
  private waitReason(): AutoMixWaitReason {
    if (!this.enabled) return null;
    if (this.phase === "mixing" || this.phase === "settle" || this.phase === "manual") return null;
    if (this.phase === "cueing" && this.stemHold) return "stems";
    if (this.preloading || (this.eagerLoading && (this.phase === "preload" || this.forced))) return "loading-next";
    const live = this.liveDeck();
    const anyLoaded = !!(this.deps.deckTrack("A") || this.deps.deckTrack("B"));
    if (live ? !live.playing : anyLoaded && !this.kickoffPlay) return "press-play";
    if (this.phase === "cueing" || this.nextOnDeck()) return null;
    if (this.deps.queue.peekNext()) return null;
    if (this.deps.queue.isFilling?.()) return "radio-filling";
    if (this.deps.queue.playlistEnded) return "playlist-ended";
    return "queue-empty";
  }

  private playingDeck(): DeckId | null {
    if (this.deps.engine.deck("A").playing) return "A";
    if (this.deps.engine.deck("B").playing) return "B";
    return null;
  }

  async tick(): Promise<void> {
    // NOT RE-ENTRANT. The app fires this every 150 ms without waiting, and idle/preload ticks await
    // a deck load that can take seconds — overlapping ticks double-loaded and double-advanced.
    if (!this.enabled || this.ticking) return;
    this.ticking = true;
    try {
      await this.tickOnce();
    } finally {
      this.ticking = false;
    }
  }

  private async tickOnce(): Promise<void> {
    const t = this.deps.now();
    const dt = this.lastTickMs == null ? 0 : Math.min(0.5, (t - this.lastTickMs) / 1000);
    this.lastTickMs = t;

    // Co-pilot: keep the radio queue topped up from BOTH loaded decks (fire & forget).
    void this.maybeFillRadio();
    // Re-sync to reality (user loads / deck switches / pauses) unless mid-transition.
    this.reconcile();
    this.followJumps(dt);

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
        try {
          this.tickMixing(dt);
        } catch (err) {
          this.rescue("mixing", err);
        }
        break;
      case "manual":
        this.tickManual();
        break;
      case "settle":
        break;
    }
    this.emit(false);
  }

  // THE MIX POINT FOLLOWS THE TRACK. mixOutTime is a position in the live track, chosen once; when
  // the user moved the track under it (operator, 2026-11-04: "if i mess with the jog while its on,
  // the timing for next song does not respond properly") nothing re-chose it. Search past the exit
  // and AUTO mixed the moment it was reached — at once, with a full-length blend running into the
  // outro; search back and it still aimed at the old point. Now a jump re-plans from where you
  // landed: armed re-picks the exit (not behind the playhead), cueing keeps the cued deck and only
  // moves the exit. Preload re-plans on its own; a running mix is timed on wall clock, not position.
  private lastLivePos: number | null = null;
  private lastLiveFor: DeckId | null = null;
  private followJumps(dt: number): void {
    const live = this.liveDeck();
    if (!live || !this.liveId) {
      this.lastLivePos = null;
      return;
    }
    const pos = live.position();
    const prev = this.lastLiveFor === this.liveId ? this.lastLivePos : null;
    this.lastLivePos = pos;
    this.lastLiveFor = this.liveId;
    if (prev == null || this.forced || this.mixOutTime == null) return;
    if (this.phase !== "armed" && this.phase !== "cueing") return;
    if (live.loop?.active || this.holdLoop) return; // a loop wraps every cycle — that is not a seek
    const rate = live.rate > 0 ? live.rate : 1;
    const expected = prev + (live.playing ? dt * rate : 0);
    if (Math.abs(pos - expected) < JUMP_S) return;
    event("automix.replan", { phase: this.phase, from: +prev.toFixed(1), to: +pos.toFixed(1), was: +this.mixOutTime.toFixed(1) });
    if (this.phase === "armed") {
      this.mixOutTime = null; // tickArmed re-picks it from here, this same tick
      this.dd = null; // …and re-asks whether a double drop still fits from where we landed
      this.ddChecked = "";
      return;
    }
    this.mixOutTime = this.computeMixOut(live, this.barsSeconds, pos + 0.5);
    this.fitBlendToRoom(live, this.mixOutTime);
  }

  // Shorten the planned blend to what the track has left after `exitAt` (same rule Mix now always
  // used): a 24-bar blend that starts 10 bars before the end runs the outgoing into silence.
  private fitBlendToRoom(live: Deck, exitAt: number): void {
    if (!this.plan) return;
    const bpm = live.effectiveBpm ?? live.beatgrid?.bpm ?? 0;
    const room = (live.duration || 0) - END_GUARD - exitAt;
    if (room > 0 && this.barsSeconds > room && bpm > 0) {
      const bars = phraseBars(Math.max(2, room / barsToSeconds(1, bpm)));
      if (bars < this.plan.bars) {
        this.plan = { ...this.plan, bars, bassSwapBar: this.plan.bassSwapBar ? phraseSwapBar(bars) : 0 };
        this.barsSeconds = barsToSeconds(bars, bpm);
      }
    }
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
    const aPlay = playingOrHeld(e.deck("A"));
    const bPlay = playingOrHeld(e.deck("B"));
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
    this.claimable[id] = this.liveVideoId; // it has been live → AUTO may load over it later
    const wasQueued = this.deps.queue.setCurrent(this.deps.deckTrack(id)) === true;
    if (this.liveVideoId && this.liveVideoId !== prev) {
      // A user-driven track change resets the "vibe" anchor — suggestions should now
      // tether to what they just put on, not the original auto-mix seed. A fresh anchor is at
      // full strength: age 0.
      this.anchor = this.deps.deckTrack(id);
      this.anchorAge = 0;
      this.held = false; // Hold was "stay on THAT track"
      // Re-seed only on a real CHANGE of live track. From nothing (prev null — AUTO just switched
      // on, or the decks were stopped) there is no old seed to replace, and reseeding here is what
      // made pressing AUTO throw away the queue the user was looking at.
      // …and not when the new track came OUT of the list (operator, 2026-11-05: "loading a song
      // completely reloads all the suggestions even though the song loaded is part of the
      // suggestions"). Playing one of them is following the list, not leaving it.
      if (prev && !wasQueued) this.deps.queue.reseedRadio();
    }
    this.resetArm();
    this.phase = "armed";
  }

  // THE USER'S TRACK ON THE IDLE DECK. Before AUTO loads onto `idle`, check what is there: if it
  // is a track the user put there (not one AUTO loaded, not one that has already been live) and it
  // is not already the next track, queue it at the front as a user pick instead of loading over
  // it. It is then the next track, and the preload latches it where it sits.
  private protectIdle(idle: DeckId): void {
    const t = this.deps.deckTrack(idle);
    if (!t?.videoId || this.claimable[idle] === t.videoId) return;
    if (this.deps.engine.deck(idle).playing) return; // a playing deck is reconcile's business
    this.claimable[idle] = t.videoId; // decided once: queued now, and AUTO's to manage from here
    if (this.deps.queue.peekNext()?.videoId === t.videoId) return;
    this.deps.queue.enqueueNext(t);
    event("automix.keepIdle", { deck: idle, id: t.videoId });
  }

  // Natural track-end autoplay-continue: load + play the next queued track onto the
  // free deck (a plain continue when no mix was in progress).
  private async advanceToNext(): Promise<void> {
    if (this.preloading || !this.liveId) return;
    // Guard BEFORE the first await: reconcile calls this every tick while the deck sits at its end,
    // and ensureNext can take a network round trip. Set after it (the old order), a second call
    // got through, loaded the track after next onto the OTHER deck and advanced the queue twice.
    this.preloading = true;
    const g = this.gen;
    const target = other(this.liveId);
    try {
      if (this.deps.engine.deck(target).playing) return; // don't stomp a deck in use
      this.protectIdle(target);
      const next = await this.deps.queue.ensureNext(this.radioCtx());
      if (!next || !this.enabled || !this.liveId || this.gen !== g || other(this.liveId) !== target) return;
      if (this.deps.engine.deck(target).playing) return;
      if (this.deps.deckTrack(target)?.videoId !== next.videoId) {
        await this.deps.loadDeck(target, next);
        if (!this.enabled || this.gen !== g) return;
        if (!this.landed(next.videoId, this.deps.deckTrack(target)?.videoId === next.videoId)) return; // didn't land → drop + try a different track
      }
      this.claimable[target] = next.videoId;
      this.stageGain(target); // level it BEFORE it is audible
      this.deps.engine.deck(target).play();
      const sign = target === "A" ? -1 : 1;
      this.deps.applyCrossfade(sign);
      this.lastXfade = sign;
      // Remove THIS track by id — not "pop the head", which is a different track if the queue
      // moved while it loaded.
      this.deps.queue.remove(next.videoId);
      this.deps.queue.setCurrent(next);
      this.advancedByAuto(); // AUTO chose this one — age the anchor, move along the arc
      this.liveId = target;
      this.liveVideoId = next.videoId;
      this.held = false; // Hold applied to the track that just ended
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
    const loaded = this.kickoffDeck();
    if (loaded) {
      if (this.kickoffPlay) {
        // THE AUTO PRESS IS THE "GO". A track is on a deck and nothing is playing: start it.
        this.kickoffPlay = false;
        this.startLoaded(loaded);
        return;
      }
      // Any LATER moment with nothing playing (the user stopped both decks after taking a mix
      // over): adopt the deck as context — radio seeds from it — and wait for play. AUTO only
      // force-starts on the AUTO press itself.
      const vid = this.deps.deckTrack(loaded)?.videoId ?? null;
      if (this.liveId !== loaded || this.liveVideoId !== vid) this.adoptLive(loaded);
      return;
    }
    if (this.preloading) return;
    const first = this.deps.queue.peekNext();
    if (!first) return;
    const g = this.gen;
    this.preloading = true;
    this.kickoffPlay = false;
    this.emit(false);
    try {
      await this.deps.loadDeck("A", first);
      if (!this.enabled || this.gen !== g) return;
      if (!this.landed(first.videoId, this.deps.deckTrack("A")?.videoId === first.videoId)) return; // didn't land → drop + try a different track
      this.claimable.A = first.videoId;
      this.stageGain("A"); // level it BEFORE it is audible
      this.deps.engine.deck("A").play();
      this.deps.applyCrossfade(-1);
      this.lastXfade = -1;
      this.liveId = "A";
      this.liveVideoId = first.videoId;
      this.deps.queue.remove(first.videoId);
      this.deps.queue.setCurrent(first);
      this.phase = "armed";
    } catch {
      /* retry next tick */
    } finally {
      this.preloading = false;
    }
  }

  // Which loaded deck to start on the AUTO press: the one the crossfader already lets through
  // (left of centre → A, right → B; centre → A), else whichever deck has a track.
  private kickoffDeck(): DeckId | null {
    const a = !!this.deps.deckTrack("A");
    const b = !!this.deps.deckTrack("B");
    if (!a && !b) return null;
    const prefer: DeckId = this.deps.getCrossfade() > 0 ? "B" : "A";
    if (prefer === "A") return a ? "A" : "B";
    return b ? "B" : "A";
  }

  // Start a deck the user loaded, as the first live track of this AUTO session. The track is the
  // user's own choice, so it becomes the vibe anchor; the queue is left exactly as it was.
  private startLoaded(id: DeckId): void {
    const track = this.deps.deckTrack(id);
    this.gen++;
    this.liveId = id;
    this.liveVideoId = track?.videoId ?? null;
    this.claimable[id] = this.liveVideoId;
    this.anchor = track;
    this.anchorAge = 0;
    this.deps.queue.setCurrent(track);
    this.stageGain(id);
    const sign = id === "A" ? -1 : 1;
    this.deps.applyCrossfade(sign); // make sure it is the deck the room hears
    this.lastXfade = sign;
    const d = this.deps.engine.deck(id);
    d.play();
    // Seed the edge so the next reconcile does not read this start as the user dropping a track.
    this.wasPlaying = { A: this.deps.engine.deck("A").playing, B: this.deps.engine.deck("B").playing };
    this.resetArm();
    this.phase = "armed";
    event("automix.kickoff", { deck: id, id: this.liveVideoId });
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
      this.mixOutTime = this.computeMixOut(live, this.barsSeconds, live.position() + CUE_LEAD_S);
    }
    this.maybePlanDoubleDrop(live);
    if (this.forced) {
      this.phase = "preload"; // Mix now: no lead-in to wait for
      return;
    }
    if (this.held) return; // Hold: keep the mix point on screen, never start toward it
    const lead = this.barsSeconds + 8;
    if (live.position() >= (this.mixOutTime ?? Infinity) - lead) this.phase = "preload";
  }

  // THE DOUBLE DROP IS DECIDED WHILE WE WAIT. It moves the mix point EARLIER (eight bars before the
  // outgoing's last hook, not after it), so it cannot be a mix-time choice like the other gestures:
  // by the time the normal preload fires, its start is already behind us. The incoming is decoded on
  // the idle deck long before (ensurePreload), so its structure is known — plan once per track.
  private maybePlanDoubleDrop(live: Deck): void {
    if (!this.liveId || this.forced) return;
    const idle = other(this.liveId);
    const t = this.preloadedId === idle ? this.preloadedTrack : null;
    if (!t?.videoId || this.ddChecked === t.videoId) return;
    this.ddChecked = t.videoId;
    this.dd = null;
    const inc = this.deps.engine.deck(idle);
    const liveT = this.deps.deckTrack(this.liveId);
    const incT = this.deps.deckTrack(idle);
    const liveBpm = live.beatgrid?.bpm ?? null;
    const plan = planDoubleDrop(
      { sections: this.sectionsOf(live), bpm: liveBpm, key: liveT?.key ?? live.key?.camelot ?? null, energy: liveT?.energy },
      { sections: this.sectionsOf(inc), bpm: inc.beatgrid?.bpm ?? null, key: incT?.key ?? inc.key?.camelot ?? null, energy: incT?.energy },
      {
        lockable: tempoLockable(live.effectiveBpm ?? liveBpm, inc.beatgrid?.bpm),
        notBefore: live.position() + CUE_LEAD_S + barsToSeconds(2, liveBpm ?? 0),
        arc: this.deps.queue.arc,
        lastStyle: this.lastStyle,
        perf: this.perf(),
      },
    );
    if (!plan || !live.beatgrid || !inc.beatgrid) return;
    this.dd = {
      videoId: t.videoId,
      mixOut: nearestDownbeat(live.beatgrid, plan.mixOut, live.position() + CUE_LEAD_S),
      mixIn: nearestDownbeat(inc.beatgrid, plan.mixIn),
    };
    this.mixOutTime = this.dd.mixOut; // the countdown now points at the build, not the old exit
    this.barsSeconds = barsToSeconds(DD_BARS, liveBpm ?? 0);
    event("automix.doubleDrop", { planned: Math.round(this.dd.mixOut), drop: Math.round(plan.drop), inc: Math.round(plan.incDrop) });
  }

  // Eagerly load the next queued track onto the idle deck while the current one plays, so
  // the desktop stem pipeline has the whole track to separate before the blend. No cue here
  // (no seek/EQ/crossfade) — just decode + analysis + stems; the cue rides the loaded deck
  // at mix time. Fire-and-forget from tickArmed; idempotent + re-entry-guarded.
  private async ensurePreload(): Promise<void> {
    if (this.eagerLoading || this.preloading || !this.liveId) return;
    const idle = other(this.liveId);
    if (this.deps.engine.deck(idle).playing) return; // user is on that deck — don't grab it
    // Guard BEFORE the await (ensureNext can be a network fetch) — set after it, two armed ticks
    // both got through and loaded the idle deck twice.
    this.eagerLoading = true;
    const g = this.gen;
    try {
      this.protectIdle(idle); // a track the user put on the idle deck is queued, never loaded over
      const next = await this.deps.queue.ensureNext(this.radioCtx());
      if (!next || !this.enabled || !this.liveId || this.gen !== g) return;
      const tgt = other(this.liveId);
      if (tgt !== idle || this.deps.engine.deck(tgt).playing) return;
      // Already sitting on the idle deck (we loaded it, or the user's track was queued above)?
      // Latch it as preloaded so we don't reload — its stems are already deriving.
      if (this.deps.deckTrack(tgt)?.videoId === next.videoId) {
        this.preloadedId = tgt;
        this.preloadedTrack = next;
        return;
      }
      await this.deps.loadDeck(tgt, next); // decode + analysis + (desktop) neural stems — EARLY
      if (this.enabled && this.liveId != null && this.gen === g && !this.deps.engine.deck(tgt).playing) {
        // Only latch if it actually LANDED — loadDeck resolves even on a failed load, so latching
        // blind would re-load the same broken track every tick. landed() drops it after MAX misses.
        if (this.landed(next.videoId, this.deps.deckTrack(tgt)?.videoId === next.videoId)) {
          this.claimable[tgt] = next.videoId;
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
    // Guard BEFORE any await (see ensurePreload).
    this.preloading = true;
    const g = this.gen;
    this.emit(false); // waitReason → loading-next, before the (possibly long) load
    try {
      this.protectIdle(idle);
      // A latched preload is only honoured while it is still the queue's next track — the user
      // may have reordered, removed or queued something in front of it since it loaded.
      const head = this.deps.queue.peekNext();
      const preloaded =
        this.preloadedId === idle &&
        !!this.preloadedTrack &&
        this.deps.deckTrack(idle)?.videoId === this.preloadedTrack.videoId &&
        (!head || head.videoId === this.preloadedTrack.videoId);
      const next = preloaded ? this.preloadedTrack! : await this.deps.queue.ensureNext(this.radioCtx());
      if (!next) {
        if (this.gen === g) this.phase = this.forced ? "preload" : "armed"; // nothing queued yet — radio may fill, retry
        return;
      }
      const onDeck = this.deps.deckTrack(idle)?.videoId === next.videoId;
      if (!onDeck) await this.deps.loadDeck(idle, next);
      // Bail if the world changed under us during the async load (incl. a skip/cancel/adopt
      // that bumped the generation — otherwise we'd cue the stale next track).
      if (!this.enabled || this.liveId == null || this.gen !== g || this.deps.engine.deck(idle).playing) {
        if (this.gen === g) this.phase = "armed";
        return;
      }
      // A fresh load that didn't LAND → drop it (in landed) and retry a different track next
      // cycle, rather than cueing a deck that never got the track.
      if (!onDeck && !this.landed(next.videoId, this.deps.deckTrack(idle)?.videoId === next.videoId)) {
        this.phase = "armed";
        return;
      }
      this.claimable[idle] = next.videoId;
      this.stageGain(idle); // idempotent — a preloaded deck was already levelled at preload time
      this.markDropCue(idle); // give "Mix now" somewhere musical to jump to
      this.nextTrack = next;
      const live = this.deps.engine.deck(this.liveId);
      const inc = this.deps.engine.deck(idle);
      this.plan = pickTransition(deckDescriptor(live, this.deps.queue.getCurrent()), deckDescriptor(inc, next));
      const bpm = live.effectiveBpm ?? live.beatgrid?.bpm ?? 0;
      if (!tempoLockable(bpm, inc.beatgrid?.bpm)) {
        // Too far apart to beat-match: a 4-bar gesture with one cut (see faderX / cutPoint).
        this.plan = { ...this.plan, bars: 4, bassSwapBar: 0 };
      }
      {
        const banded = bandBars(bpm, this.plan.bars);
        if (banded !== this.plan.bars) this.plan = { ...this.plan, bars: banded, bassSwapBar: this.plan.bassSwapBar ? phraseSwapBar(banded) : 0 };
      }
      // FIT THE BLEND TO THE SECTION. The planner asks for a length based on how compatible the
      // pair is; the track decides whether it has that much to give. A 24-bar blend that starts
      // 12 bars before the outro ends straddles the seam and sounds like a mistake, so the
      // requested length is capped by the section actually available and quantised to a real
      // phrase length. Two passes: choose an exit with the requested length, then re-measure —
      // a shortened blend can leave later, which is usually the better exit.
      this.barsSeconds = barsToSeconds(this.plan.bars, bpm);
      const liveSections = this.sectionsOf(live);
      const dd = !this.forced && this.dd && this.dd.videoId === next.videoId && this.dd.mixOut >= live.position() ? this.dd : null;
      if (dd) {
        // THE DOUBLE DROP: its own cue points, its own length — skip the blend fitting entirely.
        this.plan = { ...this.plan, style: "doubleDrop", bars: DD_BARS, bassSwapBar: 0 };
        this.barsSeconds = barsToSeconds(DD_BARS, bpm);
        this.mixOutTime = dd.mixOut;
        inc.seek(dd.mixIn);
        this.plan = { ...this.plan, loopExtend: false };
        inc.setEqLow(EQ_KILL);
        const sign = this.liveId === "A" ? -1 : 1;
        this.deps.applyCrossfade(sign);
        this.lastXfade = sign;
        this.cuedIdle = idle;
        this.mixStarted = false;
        this.quietGpuStart();
        this.phase = "cueing";
        return;
      }
      if (this.forced) {
        // MIX NOW: the exit is HERE, not the structural one — recomputing it is what used to turn
        // the press into a 30 s countdown. The blend only shrinks if the track would run out first.
        this.fitBlendToRoom(live, live.position());
        this.mixOutTime = live.position();
      } else {
        const here = live.position() + 0.5; // the load may have taken a while: never an exit behind us
        if (liveSections) {
          const provisional = this.computeMixOut(live, this.barsSeconds, here);
          const fitted = blendBarsFor(liveSections, provisional, bpm, this.plan.bars);
          if (fitted !== this.plan.bars) {
            this.plan = { ...this.plan, bars: fitted, bassSwapBar: this.plan.bassSwapBar ? phraseSwapBar(fitted) : 0 };
            this.barsSeconds = barsToSeconds(fitted, bpm);
          }
        }
        this.mixOutTime = this.computeMixOut(live, this.barsSeconds, here);
        this.fitBlendToRoom(live, this.mixOutTime);
      }
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
        loopExtend: !this.forced && !!live.beatgrid && bodyAt != null && bodyAt - mixIn > this.barsSeconds * 1.35,
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
    if (this.held && !this.forced) {
      // Hold pressed while cued (hold() cancels the cue, but a cue can land from an in-flight
      // preload just after): stand down rather than mix.
      this.abandonCue();
      this.resetArm();
      this.phase = "armed";
      return;
    }
    // A hand on the outgoing platter (or a pause) holds the mix: starting the incoming under a
    // scratch is not a transition. It goes the moment the deck is playing again.
    if (!live.playing) return;
    if (this.mixOutTime != null) {
      const until = (this.mixOutTime - live.position()) / Math.max(0.25, live.rate || 1);
      if (until <= FINE_AHEAD_S && until > -0.5) this.startFine();
    }
    if (live.position() >= (this.mixOutTime ?? Infinity) - 0.004) {
      // Reached mix-out: prefer a stem swap. If the incoming deck is still separating its
      // stems, hold a moment (bounded) rather than drop to an EQ blend.
      this.stemHold = this.shouldHoldForStems(live, idle);
      if (this.stemHold) return;
      try {
        this.startMix();
      } catch (err) {
        this.rescue("start", err);
      }
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
      lock: tempoLockable(live.effectiveBpm ?? live.beatgrid?.bpm, inc.beatgrid?.bpm),
      bridge: tempoLockable(live.effectiveBpm ?? live.beatgrid?.bpm, inc.beatgrid?.bpm, BRIDGE_MAX),
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
    } else if (style === "doubleDrop") {
      const { delay } = this.borrowFx(liveId, ["delay"]);
      if (delay) {
        delay.setParam("sync", 1);
        delay.setParam("div", 2);
        delay.setParam("feedback", 0.55);
        delay.setParam("mix", 0);
      }
    } else if (style === "tempoBridge") {
      const { delay, reverb } = this.borrowFx(liveId, ["delay", "reverb"]);
      if (delay) {
        delay.setParam("sync", 1);
        delay.setParam("div", 2); // 1/8: the roll's own subdivision, so the echo and the loop agree
        delay.setParam("feedback", 0.68);
        delay.setParam("mix", 0);
      }
      if (reverb) {
        reverb.setParam("size", 0.9);
        reverb.setParam("decay", 0.85);
        reverb.setParam("mix", 0);
      }
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
      // The tail is NOT torn down here. `both` going false is usually the INCOMING deck losing
      // its separation race, and the tail depends only on the OUTGOING deck — killing it would
      // yank the user's effect off a vocal mid-phrase for a reason that has nothing to do with
      // that vocal. It is released at settle like every other borrowed thing; endVocalTail is
      // idempotent, so the exit paths still cover it.
      if (!live.hasStems) this.endVocalTail(); // …unless the OUTGOING is what went away
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

  // ★ A TRANSITION THAT THROWS MUST STILL LAND (operator, 2026-11-04: the header stuck on
  // "Mixes into … in 0s"). startMix runs from a fire-and-forget tick, so an exception in any step
  // — a borrowed FX device whose worklet never loaded, a deck reloaded under us — vanished, the
  // machine stayed in "cueing" past its mix point, retried every 150 ms and threw every time: the
  // clock sat at 0 s and the next track never came in. Now the failure is logged and the set moves
  // on with a clean cut onto the incoming deck (settle undoes everything the gesture touched).
  private rescue(where: "start" | "mixing", err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[htl] AUTO ${where} failed — cutting to the next track`, err);
    event("automix.rescue", { where, err: msg.slice(0, 160), style: this.plan?.style ?? null });
    try {
      if (this.liveId) {
        const inc = this.deps.engine.deck(other(this.liveId));
        if (!inc.playing) inc.play();
      }
      this.mixStarted = true;
      this.settle();
    } catch (err2) {
      // Even the cut failed: stand down to armed rather than loop on the same throw.
      console.error("[htl] AUTO rescue failed", err2);
      try {
        this.abandonCue();
      } catch {
        /* nothing left to undo */
      }
      this.mixStarted = false;
      this.resetArm();
      this.phase = "armed";
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
    const style =
      this.plan.style === "doubleDrop" && caps.lock && caps.grid
        ? "doubleDrop"
        : resolveStyle({ ...this.plan, style: this.plan.style === "doubleDrop" ? "blend" : this.plan.style }, caps, this.lastStyle, { shape });
    this.plan.style = style;
    // …and how the incoming ARRIVES, which is now a separate decision from how the outgoing leaves.
    this.plan.entry = caps.lock ? resolveEntry(style, caps, shape) : "open"; // a cut lands whole
    this.unlocked = !caps.lock;
    if (style === "tempoBridge") this.beginBridge(live, inc);
    // The acapella hold, when the harmony actually permits it. keyKnown is the load-bearing half:
    // pickTransition reports keyMatch:true for an UNKNOWN pair too (a neutral guess), and holding
    // a lead vocal over a bed on that guess is the way this move goes badly wrong. Unknown is not
    // permission. Subtle taste sits it out, like every other flourish.
    this.plan.acapella =
      style === "stemswap" && this.plan.keyMatch && this.plan.keyKnown && this.perf() !== "subtle";
    this.lastStyle = style;
    this.useStems = style === "stemswap";
    this.planResolved = true;
    this.forced = false; // Mix now delivered
    this.stemHold = false;
    event("automix.transition", {
      style,
      entry: this.plan.entry,
      bars: this.plan.bars,
      score: Math.round(this.plan.score * 100) / 100,
      confident: this.plan.confident,
      caps: `${caps.stems ? "s" : ""}${caps.fx ? "f" : ""}${caps.incomingBody ? "b" : ""}${caps.grid ? "g" : ""}`,
      loopExtend: !!this.plan.loopExtend,
    });

    // ★ TIMED (operator, 2026-11-04: "a huge lag spike at the time of auto mixing"). Every step of
    // the start runs in one tick; the event names the slow one in the flight recorder and a capture.
    const t0 = performance.now();
    const cost: Record<string, number> = {};
    const lap = (k: string, from: number) => {
      cost[k] = Math.round((performance.now() - from) * 10) / 10;
      return performance.now();
    };
    let tl = t0;
    this.armGesture(style, this.liveId);
    tl = lap("gesture", tl);
    // ★ THE TAIL NEEDS ONE DECK, NOT TWO. This used to sit inside the `useStems` branch below,
    // which meant the user's AUTO chain only ever engaged on a full stem swap — and a stem swap
    // needs BOTH decks separated. But the tail routes an OUTGOING stem and touches the incoming
    // deck not at all, so gating it on the pair was over-strict by exactly one deck. The visible
    // consequence was a chain sitting in everyone's rack doing nothing on most transitions.
    // beginVocalTail self-gates on the outgoing deck's own stems, so this is safe to call for
    // every gesture: an echo-out or a filter over a separated outgoing track now dissolves its
    // vocal through whatever the user has dialled, the same way a stem swap already did.
    this.beginVocalTail(this.liveId);
    tl = lap("tail", tl);
    if (this.useStems) {
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
    tl = lap("prep", tl);
    // ★ SYNC ONLY A PAIR THAT CAN LOCK. Syncing 130 BPM under 88 played the incoming ~30 % slow for
    // the whole blend and snapped it at settle; the glide dragged the outgoing the other way. An
    // unmatchable pair keeps both tempos and gets a gesture that does not need a beat-match
    // (resolveStyle never offers blend / stemswap without caps.lock).
    if (caps.lock) {
      if (engine.syncRole(idle) !== "slave") engine.toggleSync(idle);
      if (this.plan.keyMatch && engine.keyRole(idle) !== "slave") engine.toggleKey(idle);
    }
    tl = lap("sync", tl);
    if (caps.lock) this.beginGlide(live, inc);
    tl = lap("glide", tl);
    if (caps.lock) inc.play();
    else this.incPending = true; // starts on the cut's downbeat (tickMixing)
    lap("play", tl);
    const total = performance.now() - t0;
    perfWork("automix.start", total);
    event("automix.startCost", { ms: Math.round(total * 10) / 10, ...cost });
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
    // KEY-LOCK STAYS ON through the glide unless the pair is within 2 %. Real DJs leave master tempo
    // on (Kim et al.: only 2.5 % of tracks in 1,557 mixes were transposed at all); a vinyl ride over
    // a 10 % gap is a 1.6-semitone pitch bend of both records mid-blend.
    const near = (() => {
      const f = foldTempoOctave(inc.beatgrid?.bpm ?? 0, live.effectiveBpm ?? live.beatgrid?.bpm ?? 0);
      const a = live.effectiveBpm ?? live.beatgrid?.bpm ?? 0;
      return f != null && a > 0 && Math.max(f / a, a / f) - 1 <= 0.02;
    })();
    if (!this.plan?.keyMatch && near) {
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
      event("automix.handoff", { why: "fader", cf: +cf.toFixed(3), ours: +this.lastXfade.toFixed(3) });
      this.handoffToManual();
      return;
    }
    // The user stopped the incoming deck → hand off rather than fight. A hand on its platter (a
    // nudge, a quick scratch) is not a stop — see playingOrHeld.
    if (!this.incPending && !playingOrHeld(inc)) {
      event("automix.handoff", { why: "incoming stopped" });
      this.handoffToManual();
      return;
    }

    // Progress in the LIVE TRACK'S time while it plays (elapsed × its tempo), so a jog or a scratch
    // cannot scramble the fade and a pause freezes it — and so bar k of the transition IS bar k of
    // the music. It counted wall seconds against a length measured in track seconds: under the
    // tempo glide a 32-bar blend at +5 % ran ~1.6 bars ahead of the phrase it was written for.
    if (live.playing) this.mixElapsed += dt * (live.rate > 0 ? live.rate : 1);
    const p = clamp(this.mixElapsed / Math.max(0.001, this.barsSeconds), 0, 1);
    const cutK = cutBar(this.plan.style, this.plan.bars);
    const cutFrac = cutK / Math.max(1, this.plan.bars);
    const cutDone = this.atBar(live, cutK, p);

    // AN UNMATCHED PAIR STARTS THE INCOMING AT THE CUT, on the one — not at the top of the
    // transition, where it would run unsynced under the outgoing (muted, but out of phase with the
    // downbeat it is meant to land on).
    if (this.incPending && cutDone && this.plan.style !== "tempoBridge") {
      this.incPending = false;
      inc.play();
    }
    const liveSign = this.liveId === "A" ? -1 : 1;
    // A cut moves the fader at the BAR LINE (atBar: the live track's own downbeat), not when the
    // progress fraction happens to cross it on a 150 ms tick.
    const steps = this.unlocked || this.plan.style === "cut";
    const px = steps ? (cutDone ? Math.max(p, cutFrac) : Math.min(p, cutFrac - 1e-6)) : p;
    const x =
      this.plan.style === "tempoBridge"
        ? bridgeShape(p * BRIDGE.bars, this.perf() !== "subtle").fader
        : this.plan.style === "doubleDrop"
          ? this.ddShape(live, p).fader
          : faderX(this.plan.style, px, this.plan.bars, this.plan.bassSwapBar, !this.unlocked);
    const cfv = lerp(liveSign, -liveSign, x);
    this.deps.applyCrossfade(cfv);
    this.lastXfade = cfv;

    // Gradual tempo glide (and coupled vinyl pitch when not key-matching) — moves the
    // blended tempo from the outgoing BPM to the incoming BPM so settle never snaps.
    this.glideTempo(live, idle, p);

    // Re-resolve the stem race BEFORE the style branches below, so the branch that runs this tick
    // is the one the decks can actually support right now — not the one they could support when
    // the transition started.
    this.raceStems(live, inc, idle, p);

    // The bass swap: one BEAT from the swap bar's downbeat, measured on the live track's playhead
    // (so the fine loop draws it smoothly, on the beat) — see swapProgress.
    const s = this.swapProgress(live, p);
    if (this.useStems) {
      const raw = stemBlend(p, s, { keyMatch: this.plan.keyMatch, acapella: !!this.plan.acapella });
      const xg = crossfadeGains(cfv);
      const g = {
        live: faderCompensated(raw.live, this.liveId === "A" ? xg.A : xg.B),
        inc: faderCompensated(raw.inc, this.liveId === "A" ? xg.B : xg.A),
      };
      for (const k of AutoMixer.STEMS) {
        live.setStemGain(k, g.live[k]);
        inc.setStemGain(k, g.inc[k]);
      }
    } else if (this.plan.style === "tempoBridge") {
      this.tickBridge(live, inc, p);
    } else if (this.plan.style === "doubleDrop") {
      this.tickDoubleDrop(live, inc, p);
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
      rev?.setParam("mix", this.unlocked && cutDone ? 1 : wet * 0.8);
      live.setEqLow(lerp(0, EQ_KILL, clamp(p / 0.35, 0, 1))); // lows go first — never two bass lines
      live.setFilter(lerp(0, 0.7, wet)); // the dry body thins as the wet swells
      // A freeze on the tail turns the last swell into a pad the incoming walks in over — thrown
      // ON THE DOWNBEAT of the last two bars, not at whatever fraction happens to be near it.
      if (this.atBar(live, this.freezeBar(), p)) rev?.setParam("freeze", 1);
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
      dly?.setParam("mix", this.unlocked && cutDone ? 1 : wet * 0.75);
      live.setEqLow(lerp(0, EQ_KILL, clamp(p / 0.35, 0, 1))); // lows go first — never two bass lines
      live.setEqHigh(lerp(0, -6, wet));
      live.setFilter(lerp(0, 0.5, wet));
      // Freeze the repeats at the end: the outgoing is gone but its last phrase keeps ringing over
      // the incoming, which is the whole point of throwing it in the first place. On the downbeat
      // of the last two bars — a delay freezing off the grid smears the very thing it captured.
      if (this.atBar(live, this.freezeBar(), p)) dly?.setParam("freeze", 1);
    } else if (this.plan.style === "spinOut") {
      // THE SPIN OUT. A clash that no blend can fix, made deliberate: the outgoing keeps its full
      // body right up to the last bar and is then spun down (fired once, at the trigger point) as
      // the incoming lands on its "1". Everything before that is just holding steady.
      if (!this.spinFired && cutDone) {
        this.spinFired = true;
        live.spinback();
      }
      live.setEqLow(lerp(0, EQ_KILL, clamp((p - 0.6) / 0.4, 0, 1)));
    } else if (this.plan.style === "filter") {
      // Cheap one-knob filter sweep: incoming opens from a low-pass; the outgoing
      // leaves through a high-pass in the back half. Bass still swaps so lows don't
      // stack. The filter masks an unproven pairing — sounds deliberate.
      live.setFilter(lerp(0, 0.85, clamp((p - 0.45) / 0.55, 0, 1)));
      live.setEqLow(bassSwapDb(s).out);
    } else {
      // EQ3 blend: bass swap, plus duck the OUTGOING highs in the last third so the
      // hats/cymbals don't clash on the way out — a 3-band handover, not just lows.
      live.setEqLow(bassSwapDb(s).out);
      live.setEqHigh(lerp(0, -10, clamp((p - 0.6) / 0.4, 0, 1)));
      // Contextual one-knob filter motion layered on the EQ: the INCOMING slides in from
      // under a gentle low-pass over the first half, the OUTGOING ghosts out through a
      // rising high-pass over the back half — HP/LP follow whichever deck is leaving vs
      // entering. Subtler than the dedicated "filter" style; the EQ does the heavy lift.
      live.setFilter(lerp(0, 0.6, clamp((p - 0.5) / 0.5, 0, 1)));
    }
    // …and the INCOMING half, once, for every gesture — see applyEntry.
    if (!this.useStems && this.plan.style !== "tempoBridge" && this.plan.style !== "doubleDrop") this.applyEntry(inc, p, s);

    // Flourishes ride ON TOP of whatever gesture just ran, so they go last — a lift written before
    // the style's own setEqHigh would simply be overwritten.
    this.microPerform(live, inc, p);
    // The stutter window: a fast tremolo on the outgoing's filter, driven off transition progress
    // (not a timer) so pausing freezes it along with everything else.
    if (this.mixElapsed < this.stutterUntil) {
      // A 16th-note tremolo AT THIS TRACK'S TEMPO (was a fixed 8 Hz: right at 120 BPM only, and
      // drifting off the grid at any other tempo).
      const bpm = live.effectiveBpm ?? live.beatgrid?.bpm ?? 120;
      const phase = Math.sin(2 * Math.PI * (bpm / 15) * this.mixElapsed);
      live.setFilter(clamp(0.55 + 0.45 * phase, 0, 1));
    }

    // Done when the ramp finishes, the outgoing track runs out, or the user kills
    // the outgoing deck (a deliberate "drop the old track" move → finish on incoming).
    // (A hand on the outgoing platter is not that — see playingOrHeld.)
    if (p >= 1 || (live.duration && live.position() >= live.duration - 0.1) || !playingOrHeld(live)) {
      this.settle();
      return;
    }
    this.updateFine(live);
  }

  // ── THE DOUBLE DROP (shape in doubleDrop.ts) ─────────────────────────────────────────────────
  private ddShape(live: Deck, p: number) {
    const b = p * DD_BARS;
    const dropped = this.atBar(live, DD.build, p);
    const breath = this.perf() !== "subtle" && !dropped && this.atBar(live, DD.breath, p);
    return doubleDropShape(b, dropped, breath);
  }

  private tickDoubleDrop(live: Deck, inc: Deck, p: number): void {
    const sh = this.ddShape(live, p);
    inc.setFilter(sh.incFilter);
    inc.setEqLow(sh.incLowDb);
    inc.setEqHigh(sh.incHighDb);
    live.setEqLow(sh.outLowDb);
    live.setEqHigh(sh.outHighDb);
    live.setFilter(sh.outFilter);
    if (live.hasStems) live.setStemGain("vocals", sh.outVocal);
    const dly = this.borrowedFx?.saved.find((x) => x.device.kind === "delay")?.device;
    dly?.setParam("mix", sh.echo);
    if (!this.ddDropped && sh.outLowDb <= EQ_KILL && sh.incLowDb === 0) {
      this.ddDropped = true;
      event("automix.drop", { style: "doubleDrop", at: +(p * DD_BARS).toFixed(3) });
    }
  }

  // ── THE TEMPO BRIDGE ─────────────────────────────────────────────────────────────────────────
  //
  // A pair too far apart to beat-match (past the Beat-match range) but within BRIDGE_MAX. A DJ does
  // not crossfade that, and does not just cut it either when there is a bar of runway: they CATCH
  // the outgoing record in a loop, ride the tempo fader to the new track's BPM while the same bar
  // goes round (key-lock on, so it speeds up rather than chipmunks), build it — the loop halving,
  // a filter climbing, the bass pulled — take one beat of breath, and drop the new track on its
  // first real downbeat. The old record leaves as its own frozen echo. See bridgeShape for the
  // numbers and BRIDGE for the bar map.
  private beginBridge(live: Deck, inc: Deck): void {
    if (!this.plan) return;
    const liveBpm = live.beatgrid?.bpm ?? 0;
    const incBpm = inc.beatgrid?.bpm ?? 0;
    const target = foldTempoOctave(incBpm, live.effectiveBpm ?? liveBpm);
    if (!liveBpm || !target) return;
    const gap = Math.max(target / liveBpm, liveBpm / target) - 1;
    this.plan = { ...this.plan, bars: BRIDGE.bars, bassSwapBar: 0 };
    this.barsSeconds = barsToSeconds(BRIDGE.bars, liveBpm); // in the live track's time: loop passes
    this.bridge = {
      baseBeats: gap > 0.2 ? 8 : 4, // a wider ride gets a 2-bar loop: more music to hear it on
      fromPct: live.tempo ?? 0,
      toPct: (target / liveBpm - 1) * 100,
      keylock: live.keylock,
    };
    live.setKeylock(true);
    this.loopRoll(live, this.bridge.baseBeats, false); // CAUGHT, on this downbeat
    // The incoming lands on its body section — the drop — not wherever the blend cue left it.
    const s = this.sectionsOf(inc);
    const body = s ? firstBodySection(s) : null;
    if (body != null && s) inc.seek(nearestDownbeat(inc.beatgrid!, s.starts[body]));
    inc.setEqLow(0);
    inc.setFilter(0);
    this.incPending = true; // started on the drop (tickBridge), never at the top
    event("automix.bridge", { from: Math.round(liveBpm), to: Math.round(target), gap: Math.round(gap * 100), loop: this.bridge.baseBeats });
  }

  private tickBridge(live: Deck, inc: Deck, p: number): void {
    const br = this.bridge;
    if (!br) return;
    const showy = this.perf() !== "subtle";
    const b = p * BRIDGE.bars;
    const sh = bridgeShape(b, showy);
    live.setTempo(lerp(br.fromPct, br.toPct, sh.tempoT));
    live.setFilter(sh.filter);
    live.setEqLow(sh.eqLow);
    const dly = this.borrowedFx?.saved.find((x) => x.device.kind === "delay")?.device;
    const rev = this.borrowedFx?.saved.find((x) => x.device.kind === "reverb")?.device;
    dly?.setParam("mix", sh.delayMix);
    rev?.setParam("mix", sh.reverbMix);
    if (sh.freeze) dly?.setParam("freeze", 1);
    // The roll keeps the base loop's in-point (LoopEngine anchors a resize), so the halving
    // tightens onto the same downbeat the loop was caught on.
    this.loopRoll(live, sh.rollBeats > 0 ? Math.min(sh.rollBeats, br.baseBeats) : br.baseBeats, false);
    if (sh.dropped && this.incPending) {
      this.incPending = false;
      inc.play(); // ON THE ONE: the fine loop has the clock within a frame of this bar line
      event("automix.drop", { at: +b.toFixed(3) });
    }
  }

  private endBridge(): void {
    const br = this.bridge;
    this.bridge = null;
    if (!br || !this.liveId) return;
    try {
      this.deps.engine.deck(this.liveId).setKeylock(br.keylock); // the user's own setting back
    } catch {
      /* deck gone */
    }
  }

  // ── THE AUDIO CLOCK ────────────────────────────────────────────────────────────────────────────
  //
  // The mixer ticks every 150 ms — a third of a beat at 128 BPM. Every DISCRETE moment of a
  // transition (the bass swap, a cut, a freeze, a spinback) used to wait for the first tick past
  // its fraction of the progress, so "on the one" meant up to a 16th note late, every time. Now
  // each moment is a BAR LINE of the live track (its own beat grid, counted from the mix-out
  // downbeat), tested against the playhead — which reads the AudioContext clock — and for the
  // ~third of a second around each one the mixer redraws every 16 ms. The moment lands within a
  // frame of the beat; the rest of the transition costs what it always did.

  /** The live track's position of the k-th bar line after the mix-out downbeat. Null without a grid. */
  private barPos(live: Deck, k: number): number | null {
    const g = live.beatgrid;
    if (!g?.beats?.length || this.mixOutTime == null) return null;
    // +10 ms: inside the downbeat's own interval, so float32 grid storage cannot read the beat
    // before it as "at or before" (beatTimeOffset counts from the beat at-or-before its anchor).
    return beatTimeOffset(g, this.mixOutTime + 0.01, Math.max(0, k) * BEATS_PER_BAR);
  }

  /** Has the live track reached the k-th bar line? Without a grid, the progress fraction decides. */
  private atBar(live: Deck, k: number, p: number): boolean {
    const pos = this.barPos(live, k);
    if (pos == null || !this.plan) return p >= k / Math.max(1, this.plan?.bars ?? 1);
    return live.position() >= pos - 0.004;
  }

  /** The bar an echo/wash freezes on: the cut for an unmatched pair, else the last two bars. */
  private freezeBar(): number {
    if (!this.plan) return 0;
    return this.unlocked ? cutBar(this.plan.style, this.plan.bars) : Math.max(0, this.plan.bars - 2);
  }

  /** The bass swap's progress 0..1: one beat from the swap bar's downbeat, on the playhead. */
  private swapProgress(live: Deck, p: number): number {
    if (!this.plan) return 0;
    const k = this.plan.style === "cut" ? 0 : this.plan.bassSwapBar;
    const start = this.barPos(live, k);
    const g = live.beatgrid;
    if (start == null || !g) {
      const swapStart = k / Math.max(1, this.plan.bars);
      return clamp((p - swapStart) / Math.max(0.001, 1 / Math.max(1, this.plan.bars * 4)), 0, 1);
    }
    const beat = beatTimeOffset(g, start + 0.01, 1) - start;
    return clamp((live.position() - start) / Math.max(0.05, beat), 0, 1);
  }

  /** The bar lines this transition does something exact on. */
  private moments(): number[] {
    if (!this.plan) return [];
    if (this.plan.style === "tempoBridge") return [...BRIDGE.roll, BRIDGE.breath, BRIDGE.drop];
    if (this.plan.style === "doubleDrop") return [DD.breath, DD.build, DD_BARS];
    const out: number[] = [];
    const style = this.plan.style;
    if (style === "blend" || style === "filter" || style === "stemswap" || style === "cut") out.push(style === "cut" ? 0 : this.plan.bassSwapBar);
    if (this.unlocked || style === "cut" || style === "spinOut") out.push(cutBar(style, this.plan.bars));
    if (style === "echoOut" || style === "washOut") out.push(this.freezeBar());
    return out;
  }

  /** Run the 16 ms loop while any moment is within FINE_AHEAD_S ahead (or its beat is still being
   *  drawn), and stop it otherwise. */
  private updateFine(live: Deck): void {
    const rate = Math.max(0.25, live.effectiveRate || live.rate || 1);
    const g = live.beatgrid;
    const now = live.position();
    let near = false;
    const looped = this.plan?.style === "tempoBridge";
    const barTrack = this.plan ? this.barsSeconds / Math.max(1, this.plan.bars) : 0;
    for (const k of this.moments()) {
      if (looped) {
        // The playhead wraps inside the loop, so a bridge moment is counted in progress (track
        // time) — exact now that the fine loop advances it with real time.
        const until = (k * barTrack - this.mixElapsed) / rate;
        if (until <= FINE_AHEAD_S && until >= -0.3) near = true;
        continue;
      }
      const pos = this.barPos(live, k);
      if (pos == null) continue;
      const beat = g ? beatTimeOffset(g, pos + 0.01, 1) - pos : 0.5;
      const until = (pos - now) / rate;
      if (until <= FINE_AHEAD_S && until >= -(beat / rate) - 0.05) near = true;
    }
    if (near) this.startFine();
    else this.stopFine();
  }

  /** The 16 ms loop. It advances the transition with REAL elapsed time (and moves the main tick's
   *  reference along with it, so nothing is counted twice) — the bridge counts its bars in that
   *  progress, and the continuous ramps draw smoothly through the moment as a bonus. */
  private startFine(): void {
    if (this.fineTimer) return;
    this.fineTimer = setInterval(() => {
      if (!this.enabled || this.ticking || (this.phase !== "mixing" && this.phase !== "cueing")) {
        if (this.phase !== "mixing" && this.phase !== "cueing") this.stopFine();
        return;
      }
      const t = this.deps.now();
      const dt = this.lastTickMs == null ? 0 : Math.min(0.5, (t - this.lastTickMs) / 1000);
      this.lastTickMs = t;
      if (this.phase === "mixing") this.tickMixing(dt);
      else this.tickCueing();
      this.emit(false);
    }, FINE_MS);
  }

  private stopFine(): void {
    if (this.fineTimer) clearInterval(this.fineTimer);
    this.fineTimer = null;
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
    this.unlocked = false; // the cut-on-the-one state ends with the transition, however it ends
    this.incPending = false;
    this.stopFine();
    this.endBridge();
    this.dd = null;
    this.ddChecked = "";
    this.ddDropped = false;
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
      this.claimable[this.liveId] = this.liveVideoId;
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
    // What the room is left with: a settle onto a deck that is not playing is silence.
    event("automix.settle", { style: this.plan?.style ?? null, onto: idle, playing: inc.playing, pos: +inc.position().toFixed(2) });
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
    this.unlocked = false; // the cut-on-the-one state ends with the transition, however it ends
    this.incPending = false;
    this.stopFine();
    this.endBridge();
    this.dd = null;
    this.ddChecked = "";
    this.ddDropped = false;
    this.returnFx(); // borrowed FX devices must never outlive the transition
    this.endVocalTail(); // …and neither may an AUTO-owned chain
    this.releaseHoldLoop();
    this.spinFired = false;
    this.stutterFired = false;
    this.stutterUntil = 0;
    // Remove the track that ACTUALLY played, by id. `queue.advance()` popped the head, which is a
    // different track whenever the user queued or reordered something after the cue.
    const played = this.nextTrack ?? this.deps.deckTrack(idle);
    if (played?.videoId) this.deps.queue.remove(played.videoId);
    this.advancedByAuto(); // AUTO mixed this one in — age the anchor, move along the arc
    this.liveId = idle;
    this.liveVideoId = played?.videoId ?? null;
    this.claimable[idle] = this.liveVideoId;
    this.held = false;
    this.deps.queue.setCurrent(played);
    this.cuedIdle = null;
    this.nextTrack = null;
    this.plan = null;
    this.planResolved = false;
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
  private computeMixOut(deck: Deck, barsSeconds: number, notBefore = 0): number {
    const s = this.sectionsOf(deck);
    if (!s) return notBefore;
    const t = chooseMixOut(s, barsSeconds, END_GUARD, notBefore);
    const grid = deck.beatgrid;
    // On a BAR LINE, not just a beat (and never behind the floor the caller set).
    return grid ? nearestDownbeat(grid, t, notBefore) : t;
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
    // On a BAR LINE: the incoming starts on its own "one", which is what lands on the outgoing's.
    return t <= baseDown ? baseDown : Math.max(baseDown, nearestDownbeat(grid, t));
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

  private lastPhase: AutoMixPhase | null = null;
  private emit(force: boolean): void {
    const s = this.getStatus();
    if (s.phase !== this.lastPhase) {
      this.lastPhase = s.phase;
      event("automix.phase", { phase: s.phase });
    }
    // Everything the UI draws, at the resolution it draws it: whole seconds of countdown, 5% steps
    // of mix progress — so a mixing tick re-renders a few times a second, not on every 150 ms tick
    // for nothing.
    const key = [
      s.enabled,
      s.phase,
      s.liveDeck,
      s.planLabel ?? "",
      s.planResolved,
      Math.round(s.countdownSec ?? -1),
      s.mixProgress == null ? -1 : Math.round(s.mixProgress * 20),
      s.held,
      s.waitReason ?? "",
      s.nextOnDeck ? `${s.nextOnDeck.deck}:${s.nextOnDeck.videoId}` : "",
      s.forced,
      s.mixOutTime == null ? -1 : Math.round(s.mixOutTime),
      s.liveDuration == null ? -1 : Math.round(s.liveDuration),
    ].join("|");
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
      return { filter: lerp(-0.55, 0, clamp(p / 0.5, 0, 1)), eqLow: bassSwapDb(s).in };
    // The filter style's arrival: further down, and opening across the WHOLE blend.
    case "sweepWide":
      return { filter: lerp(-0.85, 0, p), eqLow: bassSwapDb(s).in };
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
      // Drums swap EQUAL-POWER over their bar: two different kits add as power, so the straight
      // trade the bass uses (one low end, never two) dropped the swap bar ~3 dB in its middle.
      drums: Math.cos((s * Math.PI) / 2),
      bass: rhythmOut,
      // Disjoint vocal windows: the outgoing SINGS ON until the new groove is in, leaves over
      // [0.3, 0.5]; the incoming's voice arrives over [0.55, 0.8]. The old windows faded the
      // outgoing vocal from the first beat (gone by 0.45) and brought the incoming's in only at
      // 0.6 — a track losing its singer while nothing replaced it, then ~4 bars of 24 with no voice
      // at all: half of the "dead spaces" in stem transitions (operator, 2026-11-04).
      vocals: lerp(1, 0, clamp((p - 0.3) / 0.2, 0, 1)),
      other: lerp(1, 0, liveOther),
    },
    inc: { drums: Math.sin((s * Math.PI) / 2), bass: rhythmIn, vocals: lerp(0, 1, clamp((p - 0.55) / 0.25, 0, 1)), other: incOther },
  };
}

/** Where in the transition (0..1) an UNMATCHED pair's single cut happens: the incoming starts on that
 *  downbeat and the fader moves only then. Echo/wash cut half-way (two bars of throw, two of tail
 *  over the new track); the spin when the spinback fires; a drop or a cut on the last bar. */
export function cutPoint(style: TransitionStyle, bars: number): number {
  return cutBar(style, bars) / Math.max(1, bars);
}

/** The BAR (counted from the mix-out downbeat) an unmatched pair's cut lands on — and a locked
 *  cut's, and the spinback's. Echo/wash half-way; everything else on the last bar's downbeat (the
 *  spinback used to fire at 72 %, which is no bar line at all). */
export function cutBar(style: TransitionStyle, bars: number): number {
  const b = Math.max(1, bars);
  if (style === "echoOut" || style === "washOut") return Math.max(1, Math.round(b / 2));
  return b > 1 ? b - 1 : 0;
}

/** How far ahead (s) a discrete moment switches the mixer to its fine 16 ms render loop, and how
 *  long after it the loop keeps going (a one-beat bass swap has to be drawn all the way through). */
const FINE_AHEAD_S = 0.35;
const FINE_MS = 16;

const smooth = (x: number) => {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
};

/** THE FADER, as a function of the transition. 0 = all outgoing, 1 = all incoming.
 *
 *  • A BEAT-MATCHED blend (blend / filter / stemswap) comes IN EARLY and goes OUT LATE: the incoming
 *    reaches the middle over the first quarter, both sit there, and the outgoing leaves over the
 *    final phrase (the later of the bass swap and the last 8 bars). That is the shape Kim, Yang &
 *    Nam measured from 50,742 real transitions (DAFx 2022): incoming fader up early, outgoing held
 *    to the end. A straight line from 0 to 1 is a fade — the outgoing loses level from bar one.
 *  • A CUT is a cut: nothing until its last bar's downbeat, then all of it.
 *  • An UNMATCHED pair moves the fader once, at cutPoint — before it the incoming is silent (it is
 *    not even playing), so two unsynced beats never overlap; the echo/wash tail is the only overlap.
 *  • Every other gesture keeps the straight line its own shaping was written against. */
export function faderX(style: TransitionStyle, p: number, bars: number, swapBar: number, lock: boolean): number {
  if (!lock) {
    const cut = cutPoint(style, bars);
    if (p < cut) return 0;
    if (style === "echoOut" || style === "washOut") return 0.5 + 0.5 * smooth((p - cut) / Math.max(1e-3, 1 - cut));
    return 1;
  }
  if (style === "cut") return p < cutPoint("cut", bars) ? 0 : 1;
  if (style === "blend" || style === "filter" || style === "stemswap") {
    const b = Math.max(1, bars);
    const inEnd = 0.25;
    const outStart = Math.max(swapBar / b, 1 - Math.min(8, b / 2) / b);
    if (p < inEnd) return 0.5 * smooth(p / inEnd);
    if (p < outStart) return 0.5;
    return 0.5 + 0.5 * smooth((p - outStart) / Math.max(1e-3, 1 - outStart));
  }
  return clamp(p, 0, 1);
}

/** An EQUAL-POWER low-end handover in dB: the outgoing's low shelf follows cos, the incoming's sin,
 *  floored at the kill. The old ramp was linear in DECIBELS, which put both basses at −13 dB in the
 *  middle — about 10 dB under one full bass for half the swap: a hole in the low end. */
export function bassSwapDb(s: number): { out: number; in: number } {
  const db = (g: number) => (g <= 1e-4 ? EQ_KILL : Math.max(EQ_KILL, 20 * Math.log10(g)));
  const t = clamp(s, 0, 1);
  return { out: db(Math.cos((t * Math.PI) / 2)), in: db(Math.sin((t * Math.PI) / 2)) };
}

/** Highest stem level the deck accepts (Deck.setStemGain clamps to it). */
export const STEM_GAIN_MAX = 1.5;

/** THE STEM LEVELS ARE THE CROSSFADE. In a stem swap stemBlend already says how loud each part of
 *  each deck should be; the crossfader moving across the same blend took a second bite out of the
 *  same signal. The equal-power fader sits both decks at −3 dB in the middle, exactly where the
 *  outgoing has lost its vocal and the incoming has not yet brought its parts in, and the sum fell
 *  4.5–5 dB for a third of the blend (measured, stemLevel.test.ts) — the "dead spaces" in stem
 *  transitions (operator, 2026-11-04). Dividing each stem by the fader gain it is about to pass
 *  through makes what you HEAR equal stemBlend's numbers; the fader still moves, so the screen,
 *  the handoff detection and a grab all behave as before. Capped at the deck's ceiling: where the
 *  fader has a deck almost shut, a stem cannot make that back, and it is on its way out anyway. */
export function faderCompensated(g: StemGains, fader: number): StemGains {
  const c = (v: number) => (v <= 0 ? 0 : fader <= 1e-3 ? STEM_GAIN_MAX : Math.min(STEM_GAIN_MAX, v / fader));
  return { drums: c(g.drums), bass: c(g.bass), vocals: c(g.vocals), other: c(g.other) };
}

export function other(id: DeckId): DeckId {
  return id === "A" ? "B" : "A";
}
export function barsToSeconds(bars: number, bpm: number): number {
  if (!bpm || bpm <= 0) return bars * 2;
  return (bars * BEATS_PER_BAR * 60) / bpm;
}
