import type { AudioEngine, DeckId } from "../audio";
import { nearestBeat } from "../analysis";
import type { TrackMeta } from "../library/types";
import { pickTransition } from "./mixability";
import type { AutoMixPhase, TransitionPlan } from "./types";
import type { MixQueue } from "./queue";

// The AutoMixer is an automated DJ: it drives the SAME engine/deck controls the UI
// buttons drive (play, seek, toggleSync, toggleKey, setEqLow, crossfade), scheduled
// against the live deck's beatgrid. It owns no audio nodes.
//
// Lifecycle (per transition):
//   armed   — a live deck is playing; we know where its mix-out point is.
//   preload — the next track is loaded onto the idle deck and analysed.
//   cueing  — idle deck seeked to its mix-in point, low pre-killed, fader parked.
//   mixing  — idle deck started + sync/key engaged; fader + bass swap ride over N bars.
//   settle  — outgoing deck reset & released; the idle deck becomes live; advance.

type Deck = ReturnType<AudioEngine["deck"]>;

const EQ_KILL = -26; // dB — the engine's low-shelf floor (a full bass cut)
const END_GUARD = 4; // s — never mix out closer than this to the track end
const BEATS_PER_BAR = 4;

export interface AutoMixStatus {
  enabled: boolean;
  phase: AutoMixPhase;
  liveDeck: DeckId | null;
  plan: TransitionPlan | null;
  /** Live-deck position (s) where the mix begins — for the waveform marker. */
  mixOutTime: number | null;
  /** Seconds until the mix begins (armed/cueing), else null. */
  countdownSec: number | null;
}

export interface AutoMixerDeps {
  engine: AudioEngine;
  queue: MixQueue;
  /** Load a track onto a deck (also broadcasts in a session). Resolves once the
   *  buffer + analysis are attached to the deck. */
  loadDeck: (id: DeckId, track: TrackMeta) => Promise<void>;
  /** The track metadata currently loaded on a deck (videoId/key/bpm), so the mixer
   *  can adopt a manually-started deck and seed radio from it. */
  deckTrack: (id: DeckId) => TrackMeta | null;
  /** Apply a crossfade value (updates engine + React state + session intent). */
  applyCrossfade: (x: number) => void;
  /** Status changed meaningfully (phase / countdown) — re-render + (later) broadcast. */
  onChange: (s: AutoMixStatus) => void;
}

/** A minimal mixability descriptor pulled from a deck's live analysis. */
function deckDescriptor(deck: Deck, fallback: TrackMeta | null): TrackMeta {
  const camelot = deck.key?.camelot ?? fallback?.key ?? null;
  const bpm = deck.beatgrid?.bpm ?? fallback?.bpm ?? null;
  return {
    videoId: fallback?.videoId ?? "",
    title: fallback?.title ?? "",
    artist: fallback?.artist ?? "",
    duration: deck.duration || (fallback?.duration ?? 0),
    thumbnail: fallback?.thumbnail ?? null,
    views: fallback?.views ?? null,
    key: camelot,
    bpm,
  };
}

export class AutoMixer {
  private enabled = false;
  private phase: AutoMixPhase = "idle";
  private liveId: DeckId | null = null;
  private plan: TransitionPlan | null = null;
  private mixOutTime: number | null = null;
  private barsSeconds = 0;
  private preloading = false;
  private nextTrack: TrackMeta | null = null;
  private mixStarted = false;
  private useStems = false;
  private lastEmitKey = "";

  constructor(private deps: AutoMixerDeps) {}

  isEnabled(): boolean {
    return this.enabled;
  }

  enable(): void {
    if (this.enabled) return;
    this.enabled = true;
    // Adopt whichever deck is already playing as the live deck; else stay idle and
    // the first tick kicks off from the queue.
    this.liveId = this.playingDeck();
    if (this.liveId && !this.deps.queue.getCurrent()) {
      this.deps.queue.setCurrent(this.deps.deckTrack(this.liveId));
    }
    this.phase = this.liveId ? "armed" : "idle";
    this.emit(true);
  }

  disable(): void {
    if (!this.enabled) return;
    this.cancel();
    this.enabled = false;
    this.phase = "idle";
    this.emit(true);
  }

  /** Force the pending mix to begin now (skip the wait). */
  mixNow(): void {
    if (!this.enabled || !this.liveId) return;
    if (this.phase === "armed" || this.phase === "preload" || this.phase === "cueing") {
      // Pull the mix-out point back to ~now so the next tick starts mixing.
      const live = this.deps.engine.deck(this.liveId);
      this.mixOutTime = live.position();
      void this.tick();
    }
  }

  /** Drop the upcoming track (and any in-flight preload) and re-arm on the current. */
  skip(): void {
    if (!this.enabled) return;
    this.cancelPending();
    this.deps.queue.remove(this.nextTrack?.videoId ?? "");
    this.nextTrack = null;
    this.phase = this.liveId ? "armed" : "idle";
    this.emit(true);
  }

  /** Stay on the current track — cancel the armed/in-progress mix. */
  hold(): void {
    this.cancel();
  }

  /** Abort any in-progress transition and reset transient deck state. */
  cancel(): void {
    this.cancelPending();
    if (this.phase === "mixing" && this.liveId) {
      // Leave the live deck playing, undo the half-applied transition.
      const idle = other(this.liveId);
      const live = this.deps.engine.deck(this.liveId);
      const inc = this.deps.engine.deck(idle);
      inc.pause();
      inc.resetEq();
      inc.resetStems();
      live.resetEq();
      live.resetStems();
      this.releaseLocks(idle);
      this.deps.applyCrossfade(this.liveId === "A" ? -1 : 1);
      this.useStems = false;
    }
    this.phase = this.liveId ? "armed" : "idle";
    this.emit(true);
  }

  private cancelPending(): void {
    this.preloading = false;
    this.mixStarted = false;
    this.plan = null;
    this.mixOutTime = null;
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
    const live = this.deps.engine.deck(this.liveId);
    return Math.max(0, this.mixOutTime - live.position());
  }

  private playingDeck(): DeckId | null {
    if (this.deps.engine.deck("A").playing) return "A";
    if (this.deps.engine.deck("B").playing) return "B";
    return null;
  }

  /** Called on a steady interval while AUTO is on. */
  async tick(): Promise<void> {
    if (!this.enabled) return;
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
        this.tickMixing();
        break;
      case "settle":
        break;
    }
    this.emit(false);
  }

  // No live deck yet: adopt a deck the user just started, else start the first
  // queued track on deck A.
  private async tryKickoff(): Promise<void> {
    const playing = this.playingDeck();
    if (playing) {
      this.liveId = playing;
      if (!this.deps.queue.getCurrent()) this.deps.queue.setCurrent(this.deps.deckTrack(playing));
      this.phase = "armed";
      return;
    }
    if (this.preloading) return;
    const first = this.deps.queue.advance() ?? this.deps.queue.peekNext();
    if (!first) return;
    this.preloading = true;
    try {
      await this.deps.loadDeck("A", first);
      this.deps.engine.deck("A").play();
      this.deps.applyCrossfade(-1); // full A
      this.liveId = "A";
      this.deps.queue.setCurrent(first);
      this.phase = "armed";
    } catch {
      /* couldn't load — try again next tick */
    } finally {
      this.preloading = false;
    }
  }

  private liveDeck(): Deck | null {
    return this.liveId ? this.deps.engine.deck(this.liveId) : null;
  }

  // Decide where this track mixes out and whether it's time to preload.
  private tickArmed(): void {
    const live = this.liveDeck();
    if (!live || !live.playing) {
      // Live deck stopped (ended / paused) — re-evaluate.
      this.liveId = this.playingDeck();
      if (!this.liveId) this.phase = "idle";
      return;
    }
    if (this.mixOutTime == null) {
      // Provisional window sizing (a default 12-bar blend) just to find a mix-out
      // point. Refined once the incoming track is loaded + analysed (tickPreload).
      this.barsSeconds = barsToSeconds(12, live.effectiveBpm ?? live.beatgrid?.bpm ?? 0);
      this.mixOutTime = this.computeMixOut(live, this.barsSeconds);
    }
    // Preload well before the mix window opens so analysis — and, on desktop, stem
    // separation (which starts automatically on load) — has time to finish.
    const lead = this.barsSeconds + 8;
    if (live.position() >= (this.mixOutTime ?? Infinity) - lead) {
      this.phase = "preload";
    }
  }

  private async tickPreload(): Promise<void> {
    if (this.preloading) return;
    if (!this.liveId) {
      this.phase = "idle";
      return;
    }
    const idle = other(this.liveId);
    const next = await this.deps.queue.ensureNext(this.deps.queue.getCurrent() ?? this.deps.deckTrack(this.liveId));
    if (!next) {
      // Nothing to play next — fall back to armed; we'll retry (radio may fill).
      this.phase = "armed";
      return;
    }
    this.preloading = true;
    try {
      await this.deps.loadDeck(idle, next);
      this.nextTrack = next;
      const live = this.deps.engine.deck(this.liveId);
      const inc = this.deps.engine.deck(idle);
      // Refine the transition now that BOTH decks carry real analysis.
      this.plan = pickTransition(deckDescriptor(live, this.deps.queue.getCurrent()), deckDescriptor(inc, next));
      this.barsSeconds = barsToSeconds(this.plan.bars, live.effectiveBpm ?? live.beatgrid?.bpm ?? 0);
      this.mixOutTime = this.computeMixOut(live, this.barsSeconds);
      // Cue the incoming deck: seek to its mix-in point, pre-kill its low so the
      // bass doesn't clash before the swap, park the fader fully on the live deck.
      inc.seek(this.computeMixIn(inc));
      inc.setEqLow(EQ_KILL);
      this.deps.applyCrossfade(this.liveId === "A" ? -1 : 1);
      this.mixStarted = false;
      this.phase = "cueing";
    } catch {
      this.phase = "armed";
    } finally {
      this.preloading = false;
    }
  }

  private tickCueing(): void {
    const live = this.liveDeck();
    if (!live || !live.playing) {
      this.phase = "armed";
      return;
    }
    if (live.position() >= (this.mixOutTime ?? Infinity) - 0.05) {
      this.startMix();
    }
  }

  private startMix(): void {
    if (this.mixStarted || !this.liveId || !this.plan) return;
    const idle = other(this.liveId);
    const live = this.deps.engine.deck(this.liveId);
    const inc = this.deps.engine.deck(idle);
    const engine = this.deps.engine;
    // Upgrade to a stem swap when BOTH decks actually have stems by mix time
    // (separation finished). Otherwise fall back to the EQ bass-swap.
    this.useStems = live.hasStems && inc.hasStems;
    if (this.useStems) {
      this.plan.style = "stemswap";
      // Stems handle the low end now, so drop the EQ pre-kill and silence the
      // incoming kick + bass so two low ends never stack before the swap.
      inc.setEqLow(0);
      inc.setStemGain("bass", 0);
      inc.setStemGain("drums", 0);
    }
    // Engage tempo (and harmonic) match, aligning the incoming phase to the live
    // deck's CURRENT position — then start it immediately so they stay locked.
    if (engine.syncRole(idle) !== "slave") engine.toggleSync(idle);
    if (this.plan.keyMatch && engine.keyRole(idle) !== "slave") engine.toggleKey(idle);
    inc.play();
    this.mixStarted = true;
    this.phase = "mixing";
  }

  private tickMixing(): void {
    const live = this.liveDeck();
    if (!live || !this.liveId || !this.plan || this.mixOutTime == null) {
      this.settle();
      return;
    }
    const idle = other(this.liveId);
    const inc = this.deps.engine.deck(idle);
    const p = clamp((live.position() - this.mixOutTime) / Math.max(0.001, this.barsSeconds), 0, 1);

    // Crossfader: ride from full-live to full-incoming (equal-power is built in).
    const liveSign = this.liveId === "A" ? -1 : 1;
    this.deps.applyCrossfade(lerp(liveSign, -liveSign, p));

    // Low-end handover over a ~one-bar window so two basslines never stack.
    const swapStart = this.plan.style === "cut" ? 0 : this.plan.bassSwapBar / Math.max(1, this.plan.bars);
    const swapSpan = 1 / Math.max(1, this.plan.bars);
    const s = clamp((p - swapStart) / Math.max(0.001, swapSpan), 0, 1);
    if (this.useStems) {
      // Trade kick + bass between decks via the stem mixer (cleaner than EQ), and
      // duck the outgoing vocal across the blend so the two don't clash.
      live.setStemGain("bass", lerp(1, 0, s));
      live.setStemGain("drums", lerp(1, 0, s));
      inc.setStemGain("bass", lerp(0, 1, s));
      inc.setStemGain("drums", lerp(0, 1, s));
      live.setStemGain("vocals", lerp(1, 0, p));
    } else {
      live.setEqLow(lerp(0, EQ_KILL, s));
      inc.setEqLow(lerp(EQ_KILL, 0, s));
    }

    // Live track ran out, or the ramp finished → settle.
    if (p >= 1 || (live.duration && live.position() >= live.duration - 0.1) || !live.playing) {
      this.settle();
    }
  }

  private settle(): void {
    if (!this.liveId) {
      this.phase = "idle";
      return;
    }
    const idle = other(this.liveId);
    const out = this.deps.engine.deck(this.liveId);
    const inc = this.deps.engine.deck(idle);
    // Finish on the incoming deck — restore it to full (stems + EQ) for live play.
    this.deps.applyCrossfade(idle === "A" ? -1 : 1);
    inc.setEqLow(0);
    inc.resetStems();
    out.pause();
    out.resetEq();
    out.resetStems();
    this.releaseLocks(idle);
    this.useStems = false;
    // The incoming deck is now live; commit the queue (next → current).
    this.deps.queue.advance();
    this.liveId = idle;
    this.deps.queue.setCurrent(this.nextTrack);
    this.nextTrack = null;
    this.plan = null;
    this.mixOutTime = null;
    this.mixStarted = false;
    this.phase = "armed";
  }

  // Release the sync/key pair so the now-live deck runs free.
  private releaseLocks(idle: DeckId): void {
    const engine = this.deps.engine;
    if (engine.syncRole(idle) === "slave") engine.toggleSync(idle);
    if (engine.keyRole(idle) === "slave") engine.toggleKey(idle);
  }

  /** Pick the mix-out point: a phrase boundary near the natural outro, else a
   *  beat-snapped point `barsSeconds` before the end. */
  private computeMixOut(deck: Deck, barsSeconds: number): number {
    const dur = deck.duration;
    if (!dur) return 0;
    let t = dur - barsSeconds - END_GUARD;
    if (t < dur * 0.4) t = Math.max(dur * 0.4, dur - barsSeconds - 1); // short tracks
    const grid = deck.beatgrid;
    if (!grid) return t;
    const phrases = grid.phrases;
    if (phrases && phrases.length) {
      let best: number | null = null;
      let bestD = Infinity;
      for (let i = 0; i < phrases.length; i++) {
        const ph = phrases[i];
        if (ph > dur - barsSeconds * 0.5) continue; // leave room for the blend
        const d = Math.abs(ph - t);
        if (d < bestD) {
          bestD = d;
          best = ph;
        }
      }
      if (best != null && bestD < barsSeconds) return best;
    }
    return nearestBeat(grid, t);
  }

  /** Pick the incoming mix-in point: the first downbeat (start of music). */
  private computeMixIn(deck: Deck): number {
    const grid = deck.beatgrid;
    if (!grid) return 0;
    if (grid.beats && grid.beats.length && grid.downbeat != null) {
      return grid.beats[grid.downbeat] ?? grid.firstBeat ?? 0;
    }
    return grid.firstBeat ?? 0;
  }

  private emit(force: boolean): void {
    const s = this.getStatus();
    const key = `${s.enabled}|${s.phase}|${s.liveDeck}|${s.plan?.style ?? ""}|${Math.round(s.countdownSec ?? -1)}`;
    if (!force && key === this.lastEmitKey) return;
    this.lastEmitKey = key;
    this.deps.onChange(s);
  }
}

function other(id: DeckId): DeckId {
  return id === "A" ? "B" : "A";
}
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
function barsToSeconds(bars: number, bpm: number): number {
  if (!bpm || bpm <= 0) return bars * 2; // ~fallback when un-analysed
  return (bars * BEATS_PER_BAR * 60) / bpm;
}
