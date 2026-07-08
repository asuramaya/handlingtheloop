// Smart Fader — a crossfader-DRIVEN auto-transition (our take on the Pioneer DDJ-FLX4
// feature). Where the AutoMixer runs a transition on a wall-clock timer, Smart Fader makes
// the *crossfader position itself* the transition progress: you arm it, then physically
// throw the fader from the live deck to the other and the blend rides your hand.
//
// On each fader move (progress p, 0 = fully on the live deck … 1 = fully on the incoming):
//   • Tempo morph — the LIVE (master) deck's tempo is moved to lerp(liveStartBpm, incBpm, p) and
//     the incoming (a SYNC slave) follows, so the pair stays beat-locked while the common tempo
//     migrates from the live track's current BPM to the incoming's — FOLDED into the live octave
//     (half/double), the same match SYNC and the auto-mix glide use, so a big genre gap becomes a
//     small ≤√2 move (half-time DnB under house) instead of a raw ramp that lurches past a fold
//     boundary and unlocks the pair. That's the "bridge two genres" trick — and with key-lock dropped
//     it glides in pitch like a turntable (a deliberate effect; the live key/cents is in the badge).
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
import { foldTempoOctave } from "../analysis";
import { trace } from "../debug/trace";
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
    // The throw COMMANDS the master's tempo off its grid, so tell SYNC to drop the grid-rubato
    // feed-forward (it assumes grid-natural playback and fought the morph) and ride pure phase-lock.
    this.engine.setCommandedRamp(true);
    this.armed = true;
    this.apply(cf, false); // arm only — never auto-plays (so you can set the blend up while paused)
    return true;
  }

  /** Exit Smart mode: return both decks to neutral tempo / EQ / key-lock. (setTempo(0) on the slave
   *  also releases SYNC.) Leaves the crossfade where it is. */
  disarm(): void {
    if (!this.armed) return;
    this.engine.setCommandedRamp(false); // back to normal beatmatch sync (feed-forward re-acquires)
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
    this.apply(cf, true); // a real fader move (the throw) → may start the incoming rolling
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
    // Fold the incoming BPM into the LIVE deck's tempo octave (±√2) — the same half/double match
    // SYNC's matchSlaveTempo and the AutoMixer glide already use. Without this the morph ramps the
    // master RAW to the incoming's natural BPM; across a genre gap (e.g. 124 → 174) that (a) stretches
    // the master far past a clean WSOLA range and (b) makes the raw ramp CROSS a half/double fold
    // boundary — exactly where the SYNC slave's own folded target discontinuously halves/doubles. That
    // discontinuity IS the "jumps BPM drastically / can't lock the tempos" fail: the master races up
    // while the slave lurches an octave the other way. Folding relative to fromStartBpm keeps the whole
    // ramp a ≤√2 move inside ONE octave band, so the slave follows continuously (half-time DnB under a
    // house track, beat-locked — the musical result) and the pair never re-acquires mid-throw.
    this.toBpm = foldTempoOctave(toBpm, this.fromStartBpm) ?? toBpm;

    // Beat-lock incoming → live (the incoming becomes the SYNC slave; the live deck is master and
    // its tempo moves drive the slave via matchSlaveTempo). Sync only — playback starts on the
    // first THROW (see apply), never on arm, so the smart fader can be set up while paused.
    if (this.engine.syncRole(to) !== "slave") this.engine.toggleSync(to);
    return true;
  }

  /** Apply the transition at fader position `cf`. `started` = this came from a real fader move
   *  (a throw), so the incoming deck may begin rolling as it's brought in; arm passes false so
   *  merely enabling Smart Fader never starts playback. */
  private apply(cf: number, started: boolean): void {
    const from = this.fromId;
    const to = this.toId;
    if (!from || !to) return;

    // Progress along the throw: 0 when the fader sits on `from`, 1 when it reaches `to`.
    const p = clamp01(from === "A" ? (cf + 1) / 2 : (1 - cf) / 2);
    this.lastProgress = p;

    const fromDeck = this.engine.deck(from);
    const toDeck = this.engine.deck(to);

    // The throw is bringing the incoming in (and it's a user fader move, not the arm) → start it
    // rolling under the fader. Deferred to here so arming during pause stays silent.
    if (started && p > 0.001 && !toDeck.playing) toDeck.play();

    // Tempo morph: move ONLY the master (live) tempo; the SYNC slave (incoming) follows
    // automatically (half/double folded for big gaps). Common BPM migrates fromStart → incoming.
    const targetBpm = lerp(this.fromStartBpm, this.toBpm, p);
    const tempoPct = (targetBpm / this.fromBaseBpm - 1) * 100;
    trace("sf", { from, to, p: +p.toFixed(3), start: +this.fromStartBpm.toFixed(1), toFold: +this.toBpm.toFixed(1), tgt: +targetBpm.toFixed(1), pct: +tempoPct.toFixed(2), incBpm: +(toDeck.beatgrid?.bpm ?? 0).toFixed(1), incEff: +(toDeck.effectiveBpm ?? 0).toFixed(1) });
    fromDeck.setTempo(tempoPct);

    // Bass swap across the middle of the throw.
    const s = clamp01((p - BASS_LO) / (BASS_HI - BASS_LO));
    fromDeck.setEqLow(lerp(0, EQ_KILL, s));
    toDeck.setEqLow(lerp(EQ_KILL, 0, s));

    // The crossfade itself just follows the fader (equal-power curve in the engine).
    this.engine.setCrossfade(clamp(cf, -1, 1));

    // Throw complete → the incoming is now live. The whole point of "fade INTO the next song" is
    // that you LAND on it at ITS OWN natural tempo (0 shift), not the beatmatched blend tempo it
    // rode in on. Release it to natural EXPLICITLY rather than trusting the SYNC slave to have
    // settled to the exact instant — otherwise a residual bend both shows as a non-zero shift on
    // the deck you just faded into AND poisons the reverse throw (setupDirection seeds fromStartBpm
    // from the incoming's effectiveBpm). setTempo(0) on the ex-slave also drops the old sync
    // direction; setupDirection then re-locks with the roles swapped so the next throw blends back.
    if (p >= 0.999) {
      fromDeck.setEqLow(0);
      toDeck.setTempo(0);
      this.setupDirection(cf);
    }
  }
}
