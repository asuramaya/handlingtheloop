// Smart Fader — a crossfader-DRIVEN auto-transition (our take on the Pioneer DDJ-FLX4
// feature). Where the AutoMixer runs a transition on a wall-clock timer, Smart Fader makes
// the *crossfader position itself* the transition progress: you arm it, then physically
// throw the fader from the live deck to the other and the blend rides your hand.
//
// On each fader move (progress p, 0 = fully on the live deck … 1 = fully on the incoming):
//   • Tempo morph — both decks are kept beat-locked at lerp(liveBpm, incBpm, p), so the pair
//     stays matched while the common tempo migrates from the live track's BPM to the incoming
//     track's natural BPM. That's the "bridge two genres with a big BPM gap" trick: at p=0 the
//     incoming is pulled to the live tempo; at p=1 the live is pushed to the incoming tempo and
//     the incoming sits at 0 % (its own BPM).
//   • Bass swap — the live deck's LOW EQ is cut to the incoming's around the middle of the throw
//     so the two basslines never stack and mud the mix.
//   • Crossfade — the equal-power curve just follows the fader (we pass the position through).
//
// Reuses the engine primitives the AutoMixer already proved: setTempo (WSOLA-glided),
// setEqLow (the low-shelf), the crossfader curve, and SYNC for phase-lock. Echo-tail on the
// out-going deck is a deliberate v2 (needs an FxRack delay throw) — noted below.

import type { AudioEngine } from "../audio/AudioEngine";
import type { DeckId } from "../audio/index";
import { clamp, clamp01, lerp } from "../../util/math";

const EQ_KILL = -26; // dB — the engine low-shelf floor (a full bass cut), matching AutoMixer

// Bass-swap window: where in the throw the LOW EQ hands over. Centred on the middle of the
// fader so basslines cross cleanly. (0.30 → 0.70 of progress.)
const BASS_LO = 0.3;
const BASS_HI = 0.7;

export interface SmartFaderState {
  armed: boolean;
  from: DeckId | null; // outgoing (live) deck
  to: DeckId | null; // incoming deck
  progress: number; // 0..1 across the current throw
}

export class SmartFader {
  private armed = false;
  private fromId: DeckId | null = null;
  private toId: DeckId | null = null;
  private fromBpm = 0; // outgoing track's natural BPM (beatgrid)
  private toBpm = 0; // incoming track's natural BPM
  private keylockSaved: Partial<Record<DeckId, boolean>> = {};

  constructor(private engine: AudioEngine) {}

  get isArmed(): boolean {
    return this.armed;
  }

  state(): SmartFaderState {
    return { armed: this.armed, from: this.fromId, to: this.toId, progress: this.lastProgress };
  }
  private lastProgress = 0;

  /** Arm at the current crossfade position `cf` (−1 = full A … +1 = full B). Returns true if
   *  a transition could be set up (both decks have a tempo to morph between). */
  arm(cf: number): boolean {
    // The LIVE deck is the side the fader currently favours; centre → whichever is playing
    // (default A). We then transition live → other as the fader is thrown across.
    let from: DeckId;
    if (cf < -0.05) from = "A";
    else if (cf > 0.05) from = "B";
    else from = this.engine.deck("A").playing || !this.engine.deck("B").playing ? "A" : "B";
    const to: DeckId = from === "A" ? "B" : "A";

    const fromDeck = this.engine.deck(from);
    const toDeck = this.engine.deck(to);
    const fromBpm = fromDeck.beatgrid?.bpm ?? 0;
    const toBpm = toDeck.beatgrid?.bpm ?? 0;
    if (!fromBpm || !toBpm) return false; // need both grids to morph tempo — bail to plain fader

    this.fromId = from;
    this.toId = to;
    this.fromBpm = fromBpm;
    this.toBpm = toBpm;

    // Beat-lock the incoming to the live deck so it enters in time, then start it rolling under
    // the (still fully-live-side) crossfader. SYNC makes the slave follow the master's tempo.
    if (this.engine.syncRole(to) !== "slave") this.engine.toggleSync(to);

    // Tempo morph reads better as a pitch glide (turntable-style), like the AutoMixer's blend —
    // save and drop keylock on both for the duration.
    this.keylockSaved = { [from]: fromDeck.keylock, [to]: toDeck.keylock };
    fromDeck.setKeylock(false);
    toDeck.setKeylock(false);

    if (!toDeck.playing) toDeck.play();
    this.armed = true;
    this.apply(cf); // settle DSP to the current position immediately
    return true;
  }

  /** Cancel the transition, restoring tempo / EQ / keylock to neutral. Leaves the crossfade and
   *  playback where they are (so disarming mid-throw doesn't lurch). */
  disarm(): void {
    if (!this.armed) return;
    for (const id of [this.fromId, this.toId]) {
      if (!id) continue;
      const d = this.engine.deck(id);
      d.setTempo(0);
      d.setEqLow(0);
      const k = this.keylockSaved[id];
      if (k != null) d.setKeylock(k);
    }
    this.armed = false;
    this.fromId = this.toId = null;
  }

  /** Drive the transition from a crossfade position `cf` (−1..+1). Call this from the crossfader
   *  handler whenever Smart Fader is armed (instead of the plain setCrossfade). */
  onCrossfade(cf: number): void {
    if (!this.armed) {
      this.engine.setCrossfade(cf);
      return;
    }
    this.apply(cf);
  }

  private apply(cf: number): void {
    const from = this.fromId;
    const to = this.toId;
    if (!from || !to) return;

    // Progress along the throw: 0 when the fader sits on `from`, 1 when it reaches `to`.
    const p = clamp01(from === "A" ? (cf + 1) / 2 : (1 - cf) / 2);
    this.lastProgress = p;

    const fromDeck = this.engine.deck(from);
    const toDeck = this.engine.deck(to);

    // Tempo morph: keep both beat-locked at the migrating common BPM.
    const targetBpm = lerp(this.fromBpm, this.toBpm, p);
    fromDeck.setTempo((targetBpm / this.fromBpm - 1) * 100);
    toDeck.setTempo((targetBpm / this.toBpm - 1) * 100);

    // Bass swap across the middle of the throw (smooth in/out of the window).
    const s = clamp01((p - BASS_LO) / (BASS_HI - BASS_LO));
    fromDeck.setEqLow(lerp(0, EQ_KILL, s));
    toDeck.setEqLow(lerp(EQ_KILL, 0, s));

    // The crossfade itself just follows the fader (equal-power curve in the engine).
    this.engine.setCrossfade(clamp(cf, -1, 1));

    // Throw complete → the incoming is now live at its own BPM; tidy the outgoing back to neutral
    // tempo/EQ (still faded out) and stand down so the next move is a normal fader again.
    if (p >= 0.999) {
      fromDeck.setTempo(0);
      fromDeck.setEqLow(0);
      const k = this.keylockSaved[from];
      if (k != null) fromDeck.setKeylock(k);
      const kt = this.keylockSaved[to];
      if (kt != null) toDeck.setKeylock(kt);
      this.armed = false;
      this.fromId = this.toId = null;
    }
  }
}
