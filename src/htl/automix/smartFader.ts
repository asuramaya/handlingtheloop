// Smart Fader — a crossfader-DRIVEN auto-transition (our take on the Pioneer DDJ-FLX4
// feature). Where the AutoMixer runs a transition on a wall-clock timer, Smart Fader makes
// the *crossfader position itself* the transition progress: you arm it, then physically
// throw the fader from the live deck to the other and the blend rides your hand.
//
// On each fader move (progress p, 0 = fully on the live deck … 1 = fully on the incoming):
//   • Tempo morph — the LIVE (master) deck's tempo is moved to lerp(liveStartBpm, incBpm, p) and
//     the incoming (a SYNC slave) follows, so the pair stays beat-locked while the common tempo
//     migrates from the live track's current BPM to the incoming track's natural BPM. That's the
//     "bridge two genres with a big BPM gap" trick — and with key-lock dropped it glides in pitch
//     like a turntable (a deliberate effect; the live key/cents is surfaced in the deck badge).
//   • Bass swap — the live LOW EQ is cut to the incoming's around the middle of the throw so the
//     two basslines never stack and mud the mix.
//   • Crossfade — the equal-power curve just follows the fader (we pass the position through).
//
// Completing a throw RE-ARMS in the reverse direction (stays in Smart mode) so the strip keeps
// its "blendy" look and the next throw blends back; toggle the button to exit. Reuses the engine
// primitives the AutoMixer proved: setTempo (WSOLA-glided), SYNC (tempo + phase lock, half/double
// folded), setEqLow, and the crossfader curve. Echo-tail on the out-going deck is a v2.

import type { AudioEngine } from "../audio/AudioEngine";
import type { DeckId } from "../audio/index";
import { clamp, clamp01, lerp } from "../../util/math";

const EQ_KILL = -26; // dB — the engine low-shelf floor (a full bass cut), matching AutoMixer

// Bass-swap window: where in the throw the LOW EQ hands over (0.30 → 0.70 of progress).
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
  private fromStartBpm = 0; // live deck's effective BPM when the throw started (morph start)
  private fromBaseBpm = 0; // live deck's natural (beatgrid) BPM — for the tempo-% conversion
  private toBpm = 0; // incoming deck's natural BPM (morph target)
  private keylockSaved: Partial<Record<DeckId, boolean>> = {};
  private lastProgress = 0;

  constructor(private engine: AudioEngine) {}

  get isArmed(): boolean {
    return this.armed;
  }
  state(): SmartFaderState {
    return { armed: this.armed, from: this.fromId, to: this.toId, progress: this.lastProgress };
  }

  /** Arm at the current crossfade position `cf` (−1 = full A … +1 = full B). Returns false (→ plain
   *  crossfader) if a deck lacks a beatgrid to morph between. */
  arm(cf: number): boolean {
    if (this.armed) return true;
    if (!this.setupDirection(cf)) return false;
    // The pitch glide is intentional — PIN key-lock off so the tempo morph pitches the decks
    // (turntable-style) AND a manual KEY nudge mid-transition adds to the glide instead of
    // re-engaging key-lock (which would freeze it). Saved per-deck so disarm restores the setting.
    this.keylockSaved = { A: this.engine.deck("A").keylock, B: this.engine.deck("B").keylock };
    this.engine.deck("A").setKeylockPinnedOff(true);
    this.engine.deck("B").setKeylockPinnedOff(true);
    this.armed = true;
    this.apply(cf);
    return true;
  }

  /** Exit Smart mode: return both decks to neutral tempo / EQ / key-lock. (setTempo(0) on the slave
   *  also releases SYNC.) Leaves the crossfade where it is. */
  disarm(): void {
    if (!this.armed) return;
    for (const id of ["A", "B"] as DeckId[]) {
      const d = this.engine.deck(id);
      d.setTempo(0);
      d.setEqLow(0);
      d.setKeylockPinnedOff(false); // unpin first, then restore the user's saved key-lock
      const k = this.keylockSaved[id];
      if (k != null) d.setKeylock(k);
    }
    this.armed = false;
    this.fromId = this.toId = null;
  }

  /** Drive the transition from a crossfade position `cf` (−1..+1). Call from the crossfader handler
   *  whenever Smart Fader is armed (instead of the plain setCrossfade). */
  onCrossfade(cf: number): void {
    if (!this.armed) {
      this.engine.setCrossfade(cf);
      return;
    }
    this.apply(cf);
  }

  // Pick live (= the side the fader favours; centre → whichever is playing) + incoming, beat-lock
  // the incoming to the live deck (SYNC: tempo + phase) and start it rolling. Records the morph
  // endpoints. Returns false if either deck has no beatgrid. Also used to re-arm in reverse.
  private setupDirection(cf: number): boolean {
    let from: DeckId;
    if (cf < -0.05) from = "A";
    else if (cf > 0.05) from = "B";
    else from = this.engine.deck("A").playing || !this.engine.deck("B").playing ? "A" : "B";
    const to: DeckId = from === "A" ? "B" : "A";

    const fromDeck = this.engine.deck(from);
    const toDeck = this.engine.deck(to);
    const fromBase = fromDeck.beatgrid?.bpm ?? 0;
    const toBpm = toDeck.beatgrid?.bpm ?? 0;
    if (!fromBase || !toBpm) return false;

    this.fromId = from;
    this.toId = to;
    this.fromBaseBpm = fromBase;
    // Start the morph from the live deck's CURRENT effective BPM (not its natural BPM) so arming
    // never snaps a deck the DJ had pitched — the throw begins exactly where the deck is playing.
    this.fromStartBpm = fromDeck.effectiveBpm ?? fromBase;
    this.toBpm = toBpm;

    // Beat-lock incoming → live (the incoming becomes the SYNC slave; the live deck is master and
    // its tempo moves drive the slave via matchSlaveTempo). Then start it rolling under the fader.
    if (this.engine.syncRole(to) !== "slave") this.engine.toggleSync(to);
    if (!toDeck.playing) toDeck.play();
    return true;
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

    // Tempo morph: move ONLY the master (live) tempo; the SYNC slave (incoming) follows
    // automatically (half/double folded for big gaps). Common BPM migrates fromStart → incoming.
    const targetBpm = lerp(this.fromStartBpm, this.toBpm, p);
    fromDeck.setTempo((targetBpm / this.fromBaseBpm - 1) * 100);

    // Bass swap across the middle of the throw.
    const s = clamp01((p - BASS_LO) / (BASS_HI - BASS_LO));
    fromDeck.setEqLow(lerp(0, EQ_KILL, s));
    toDeck.setEqLow(lerp(EQ_KILL, 0, s));

    // The crossfade itself just follows the fader (equal-power curve in the engine).
    this.engine.setCrossfade(clamp(cf, -1, 1));

    // Throw complete → the incoming is now live at its own BPM. STAY in Smart mode: re-arm in the
    // reverse direction (keeps key-lock off) so the next throw blends back. Tidy the ex-live bass.
    if (p >= 0.999) {
      fromDeck.setEqLow(0);
      this.setupDirection(cf);
    }
  }
}
