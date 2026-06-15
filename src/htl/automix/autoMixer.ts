import type { AudioEngine, DeckId } from "../audio";
import { nearestBeat } from "../analysis";
import type { TrackMeta } from "../library/types";
import { pickTransition } from "./mixability";
import type { AutoMixPhase, MixMode, TransitionPlan } from "./types";
import type { MixQueue } from "./queue";

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
  // EAGER PRELOAD: the next track is loaded onto the idle deck the moment the current
  // track starts playing — NOT at the ~30 s mix lead-in — so the (slow) stem separation
  // has the whole current track to finish before the blend. `preloadedTrack`/`preloadedId`
  // record which track is already sitting decoded on which deck; `eagerLoading` guards the
  // async load against re-entry / a racing cue. Cue setup (seek/EQ/crossfade) still runs at
  // mix time, off the already-loaded deck.
  private preloadedId: DeckId | null = null;
  private preloadedTrack: TrackMeta | null = null;
  private eagerLoading = false;
  // The "session vibe" — the track the user last set as live. Radio seeds from this
  // PLUS the current track so suggestions stay tethered to the original vibe instead
  // of drifting track-to-track.
  private anchor: TrackMeta | null = null;
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

  constructor(private deps: AutoMixerDeps) {}

  isEnabled(): boolean {
    return this.enabled;
  }

  enable(): void {
    if (this.enabled) return;
    this.enabled = true;
    this.lastTickMs = null;
    this.liveId = this.playingDeck();
    this.liveVideoId = this.liveId ? this.deps.deckTrack(this.liveId)?.videoId ?? null : null;
    this.anchor = this.liveId ? this.deps.deckTrack(this.liveId) : null;
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
    this.anchor = null;
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

  // Keep the queue full of suggestions that fit whatever is loaded right now.
  private async maybeFillRadio(): Promise<void> {
    const live = this.liveId ? this.deps.deckTrack(this.liveId) : null;
    const otherTrack = this.liveId ? this.deps.deckTrack(other(this.liveId)) : null;
    // Live deck + the session anchor (+ the other deck) → suggestions fit the current
    // track AND the original vibe, so the set doesn't spiral away from where it started.
    const seeds = [live, this.anchor, otherTrack].filter((t): t is TrackMeta => !!t?.videoId);
    if (!seeds.length) return;
    await this.deps.queue.ensureNext(seeds);
  }

  // Absorb anything the user did to the decks between ticks — GRACEFULLY, so a
  // PAUSE or a manual LOAD is never mistaken for "skip to the next queued song".
  private reconcile(): void {
    if (this.phase === "mixing" || this.phase === "settle" || this.phase === "manual") return;
    const e = this.deps.engine;
    const aPlay = e.deck("A").playing;
    const bPlay = e.deck("B").playing;

    // Something is playing → follow it (and adopt a track the user just loaded there).
    if (aPlay || bPlay) {
      const playId: DeckId = aPlay && (this.liveId === "A" || !bPlay) ? "A" : "B";
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
    this.abandonCue();
    const prev = this.liveVideoId;
    this.liveId = id;
    this.liveVideoId = this.deps.deckTrack(id)?.videoId ?? null;
    this.deps.queue.setCurrent(this.deps.deckTrack(id));
    if (this.liveVideoId && this.liveVideoId !== prev) {
      // A user-driven track change resets the "vibe" anchor — suggestions should now
      // tether to what they just put on, not the original auto-mix seed.
      this.anchor = this.deps.deckTrack(id);
      this.deps.queue.reseedRadio();
    }
    this.resetArm();
    this.phase = "armed";
  }

  // Natural track-end autoplay-continue: load + play the next queued track onto the
  // free deck (a plain continue when no mix was in progress).
  private async advanceToNext(): Promise<void> {
    if (this.preloading || !this.liveId) return;
    const seeds = [this.deps.deckTrack("A"), this.deps.deckTrack("B")].filter((t): t is TrackMeta => !!t?.videoId);
    const next = await this.deps.queue.ensureNext(seeds.length ? seeds : this.deps.queue.getCurrent());
    if (!next || !this.enabled || !this.liveId) return;
    const target = other(this.liveId);
    if (this.deps.engine.deck(target).playing) return; // don't stomp a deck in use
    this.preloading = true;
    try {
      await this.deps.loadDeck(target, next);
      if (!this.enabled) return;
      this.deps.engine.deck(target).play();
      const sign = target === "A" ? -1 : 1;
      this.deps.applyCrossfade(sign);
      this.lastXfade = sign;
      this.deps.queue.advance();
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
    this.preloading = true;
    try {
      await this.deps.loadDeck("A", first);
      if (!this.enabled) return;
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
    // AGGRESSIVE PRELOAD: get the next track decoded + (desktop) stem-separated onto the
    // idle deck NOW, while the current track plays — buying the whole track's worth of time
    // for separation instead of the ~30 s lead-in. Fire-and-forget; the cue still happens
    // near mix-out, off the loaded deck. Runs every armed tick but latches once loaded.
    void this.ensurePreload();
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
    const seeds = [this.deps.deckTrack(this.liveId), this.deps.deckTrack(idle)].filter((t): t is TrackMeta => !!t?.videoId);
    const next = await this.deps.queue.ensureNext(seeds.length ? seeds : this.deps.queue.getCurrent());
    if (!next || !this.enabled || !this.liveId) return;
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
      if (this.enabled && this.liveId != null && !this.deps.engine.deck(tgt).playing) {
        this.preloadedId = tgt;
        this.preloadedTrack = next;
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
    const seeds = [this.deps.deckTrack(this.liveId), this.deps.deckTrack(idle)].filter((t): t is TrackMeta => !!t?.videoId);
    const next = preloaded ? this.preloadedTrack! : await this.deps.queue.ensureNext(seeds.length ? seeds : this.deps.queue.getCurrent());
    if (!next) {
      this.phase = "armed"; // nothing queued yet — radio may fill, retry later
      return;
    }
    this.preloading = true;
    try {
      if (!preloaded) await this.deps.loadDeck(idle, next);
      // Bail if the world changed under us during the async load.
      if (!this.enabled || this.liveId == null || this.deps.engine.deck(idle).playing) {
        this.phase = "armed";
        return;
      }
      this.nextTrack = next;
      const live = this.deps.engine.deck(this.liveId);
      const inc = this.deps.engine.deck(idle);
      this.plan = pickTransition(deckDescriptor(live, this.deps.queue.getCurrent()), deckDescriptor(inc, next));
      this.barsSeconds = barsToSeconds(this.plan.bars, live.effectiveBpm ?? live.beatgrid?.bpm ?? 0);
      this.mixOutTime = this.computeMixOut(live, this.barsSeconds);
      inc.seek(this.computeMixIn(inc, this.barsSeconds));
      inc.setEqLow(EQ_KILL);
      const sign = this.liveId === "A" ? -1 : 1;
      this.deps.applyCrossfade(sign);
      this.lastXfade = sign;
      this.cuedIdle = idle;
      this.mixStarted = false;
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
    if (live.position() >= (this.mixOutTime ?? Infinity) - 0.05) this.startMix();
  }

  private startMix(): void {
    if (this.mixStarted || !this.liveId || !this.plan) return;
    const idle = other(this.liveId);
    const live = this.deps.engine.deck(this.liveId);
    const inc = this.deps.engine.deck(idle);
    const engine = this.deps.engine;
    this.useStems = live.hasStems && inc.hasStems;
    if (this.useStems) {
      this.plan.style = "stemswap";
      inc.setEqLow(0);
      inc.setStemGain("bass", 0);
      inc.setStemGain("drums", 0);
    } else if (this.plan.style === "filter") {
      inc.setFilter(-0.85); // start muffled (low-pass) — opens across the mix
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
    if (!this.plan?.keyMatch) {
      this.glideKeylock = { A: this.deps.engine.deck("A").keylock, B: this.deps.engine.deck("B").keylock };
      live.setKeylock(false);
      inc.setKeylock(false);
    }
  }

  // Per-tick tempo ramp on the master; the sync slave follows via the engine's tempo hook.
  private glideTempo(live: Deck, idle: DeckId, p: number): void {
    if (!this.glideActive) return;
    const og = live.beatgrid?.bpm;
    const ig = this.deps.engine.deck(idle).beatgrid?.bpm;
    if (!og || !ig) return;
    // Fold the incoming BPM into the outgoing's tempo octave (half/double) — the same rule
    // the sync slave uses — so the glide is the minimal ≤√2 move, not a 2× lurch.
    let targetIn = ig;
    while (targetIn / og > Math.SQRT2) targetIn /= 2;
    while (targetIn / og < 1 / Math.SQRT2) targetIn *= 2;
    const eased = p * p * (3 - 2 * p); // smoothstep — gentle at both ends
    const targetBpm = og + (targetIn - og) * eased;
    live.setTempo((targetBpm / og - 1) * 100); // master moves; slave follows automatically
  }

  // Tear down the glide: restore the keylock we dropped for the vinyl pitch ride. (Tempo
  // resets are handled by the caller — settle/cancel reset to natural, handoff keeps them.)
  private endGlide(): void {
    if (this.glideKeylock) {
      this.deps.engine.deck("A").setKeylock(this.glideKeylock.A);
      this.deps.engine.deck("B").setKeylock(this.glideKeylock.B);
      this.glideKeylock = null;
    }
    this.glideActive = false;
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

    const swapStart = this.plan.style === "cut" ? 0 : this.plan.bassSwapBar / Math.max(1, this.plan.bars);
    const swapSpan = 1 / Math.max(1, this.plan.bars);
    const s = clamp((p - swapStart) / Math.max(0.001, swapSpan), 0, 1);
    if (this.useStems) {
      // Stem swap: trade kick+bass between decks, duck the outgoing vocal.
      live.setStemGain("bass", lerp(1, 0, s));
      live.setStemGain("drums", lerp(1, 0, s));
      inc.setStemGain("bass", lerp(0, 1, s));
      inc.setStemGain("drums", lerp(0, 1, s));
      live.setStemGain("vocals", lerp(1, 0, p));
    } else if (this.plan.style === "filter") {
      // Cheap one-knob filter sweep: incoming opens from a low-pass; the outgoing
      // leaves through a high-pass in the back half. Bass still swaps so lows don't
      // stack. The filter masks an unproven pairing — sounds deliberate.
      inc.setFilter(lerp(-0.85, 0, p));
      live.setFilter(lerp(0, 0.85, clamp((p - 0.45) / 0.55, 0, 1)));
      live.setEqLow(lerp(0, EQ_KILL, s));
      inc.setEqLow(lerp(EQ_KILL, 0, s));
    } else {
      // EQ3 blend: bass swap, plus duck the OUTGOING highs in the last third so the
      // hats/cymbals don't clash on the way out — a 3-band handover, not just lows.
      live.setEqLow(lerp(0, EQ_KILL, s));
      inc.setEqLow(lerp(EQ_KILL, 0, s));
      live.setEqHigh(lerp(0, -10, clamp((p - 0.6) / 0.4, 0, 1)));
      // Contextual one-knob filter motion layered on the EQ: the INCOMING slides in from
      // under a gentle low-pass over the first half, the OUTGOING ghosts out through a
      // rising high-pass over the back half — HP/LP follow whichever deck is leaving vs
      // entering. Subtler than the dedicated "filter" style; the EQ does the heavy lift.
      inc.setFilter(lerp(-0.55, 0, clamp(p / 0.5, 0, 1)));
      live.setFilter(lerp(0, 0.6, clamp((p - 0.5) / 0.5, 0, 1)));
    }

    // Done when the ramp finishes, the outgoing track runs out, or the user kills
    // the outgoing deck (a deliberate "drop the old track" move → finish on incoming).
    if (p >= 1 || (live.duration && live.position() >= live.duration - 0.1) || !live.playing) this.settle();
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
    this.mixStarted = false;
    this.plan = null;
    this.mixOutTime = null;
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
    this.deps.queue.advance();
    this.liveId = idle;
    this.liveVideoId = this.nextTrack?.videoId ?? this.deps.deckTrack(idle)?.videoId ?? null;
    this.deps.queue.setCurrent(this.nextTrack);
    this.cuedIdle = null;
    this.nextTrack = null;
    this.plan = null;
    this.mixOutTime = null;
    this.mixStarted = false;
    this.mixElapsed = 0;
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

  private computeMixOut(deck: Deck, barsSeconds: number): number {
    const dur = deck.duration;
    if (!dur) return 0;
    const grid = deck.beatgrid;
    // Measure the mix-out back from the MUSICAL end (before any fade / dead tail), not the
    // file length — otherwise the blend rides out into the silent tail. Guard against a
    // bogus bound on a quiet track (lastSound must be in the back half to be trusted).
    const end = grid?.lastSound && grid.lastSound > dur * 0.5 ? grid.lastSound : dur;
    let t = end - barsSeconds - END_GUARD;
    if (t < dur * 0.4) t = Math.max(dur * 0.4, end - barsSeconds - 1);
    if (!grid) return t;
    const phrases = grid.phrases;
    if (phrases && phrases.length) {
      // Ride out on the last outro phrase whose blend still completes by the musical end;
      // among those, take the one nearest the target t.
      let best: number | null = null;
      let bestD = Infinity;
      for (let i = 0; i < phrases.length; i++) {
        const ph = phrases[i];
        if (ph > end - barsSeconds * 0.5) continue;
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

  // Where to drop the needle on the INCOMING track. Anchored so its first body phrase (the
  // "drop", just past the loudness-trimmed intro) lands at the END of the blend — the intro
  // rides UNDER the outgoing's outro. Short intro → plays through from "1"; long intro → cut
  // so only the last blend-length sits under; no real intro → start on the downbeat.
  private computeMixIn(deck: Deck, barsSeconds: number): number {
    const grid = deck.beatgrid;
    if (!grid) return 0;
    const firstBeat = grid.firstBeat ?? 0;
    const baseDown =
      grid.beats && grid.beats.length && grid.downbeat != null ? grid.beats[grid.downbeat] ?? firstBeat : firstBeat;
    const fs = grid.firstSound ?? 0;
    // The drop = first phrase boundary at/after the content start (else the content start).
    let drop = fs;
    if (grid.phrases && grid.phrases.length) {
      for (let i = 0; i < grid.phrases.length; i++) {
        if (grid.phrases[i] >= fs - 0.1) {
          drop = grid.phrases[i];
          break;
        }
      }
    }
    if (drop <= baseDown + 0.2) return baseDown; // negligible intro → start at "1"
    return Math.max(baseDown, nearestBeat(grid, drop - barsSeconds));
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
  if (!bpm || bpm <= 0) return bars * 2;
  return (bars * BEATS_PER_BAR * 60) / bpm;
}
