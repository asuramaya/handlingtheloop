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
import type { Intent } from "../room/protocol";
import { foldTempoOctave, tempoLockable } from "../analysis";
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
  /** The pair is beat-matched across the throw (tempo morph + SYNC). False = a clean crossfade with
   *  a bass swap and both decks at their own tempo (too far apart, or no grid to lock to). */
  locked: boolean;
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
  private locked = false; // this throw is beat-matched (see tempoLockable)
  private pinned = false; // key-lock pins + commanded ramp are ours right now
  private stale = false; // something else moved the crossfader since our last apply

  // ★ A TRANSITION THAT ONLY HAPPENS HERE IS A DIVERGENCE. Smart Fader drives the decks straight
  // — tempo, EQ, play — and none of those setters touch the wire, so on a shared board the far
  // side received the crossfader position and nothing else: it heard a plain crossfade while this
  // device performed a tempo morph and a bass swap. (The AutoMixer has the same shape and solved
  // it by re-publishing the whole snapshot at each transition boundary; a fader-driven transition
  // has no boundaries to hang that on — it is continuous, under a hand.) So every move it makes
  // goes out as the ordinary intent that move already had. No new protocol, no new apply path.
  private emit: (intent: Intent) => void = () => {};
  constructor(private engine: AudioEngine) {}

  /** Wire the transition to the session. Called once by App; a solo deck leaves it unset and the
   *  emitter is a no-op, so nothing about offline behaviour changes. */
  setEmitter(fn: (intent: Intent) => void): void {
    this.emit = fn;
  }
  /** Move a deck's tempo AND say so. */
  private tempo(id: DeckId, pct: number): void {
    this.engine.deck(id).setTempo(pct);
    this.emit({ kind: "control", deck: id, param: "tempo", value: pct });
  }
  /** Move a deck's low EQ AND say so — the bass swap is the most audible half of the throw. */
  private eqLow(id: DeckId, db: number): void {
    this.engine.deck(id).setEqLow(db);
    this.emit({ kind: "control", deck: id, param: "eqLow", value: db });
  }

  get isArmed(): boolean {
    return this.armed;
  }
  state(): SmartFaderState {
    return { armed: this.armed, from: this.fromId, to: this.toId, progress: this.lastProgress, locked: this.locked };
  }

  /** The crossfader was moved by something other than this fader — AUTO's transition, a session
   *  peer. The direction and the morph's start tempo were captured for the OLD situation; after AUTO
   *  has mixed A → B, "from" is still A, and the next touch ran the morph backwards against the deck
   *  that is actually live. The next throw re-reads the decks instead of trusting that. */
  noteExternalCrossfade(): void {
    if (this.armed) this.stale = true;
  }

  /** Arm at the current crossfade position `cf` (−1 = full A … +1 = full B). Always arms; whether
   *  the throw beat-matches is decided per throw (state().locked). Returns true. */
  arm(cf: number, announce = true): boolean {
    if (this.armed) return true;
    // Saved per-deck BEFORE any pin, so disarm restores the user's own key-lock setting.
    this.keylockSaved = { A: this.engine.deck("A").keylock, B: this.engine.deck("B").keylock };
    this.setupDirection(cf);
    this.armed = true;
    // The mode itself crosses: the far side pins key-lock the same way (or its decks will not
    // glide with the morph) and its strip shows SMART instead of a plain crossfader.
    // `announce` is false when we are arming BECAUSE a co-DJ armed — the mode is shared, and a
    // re-announcement would bounce it straight back at them.
    if (announce) for (const d of ["A", "B"] as DeckId[]) this.emit({ kind: "board", deck: d, id: "smartFader", arg: "arm" });
    this.apply(cf, false); // arm only — never auto-plays (so you can set the blend up while paused)
    return true;
  }

  /** Exit Smart mode: return both decks to neutral tempo / EQ / key-lock. (setTempo(0) on the slave
   *  also releases SYNC.) Leaves the crossfade where it is. */
  disarm(announce = true): void {
    if (!this.armed) return;
    this.unpin();
    for (const id of ["A", "B"] as DeckId[]) {
      const d = this.engine.deck(id);
      this.tempo(id, 0);
      this.eqLow(id, 0);
      const k = this.keylockSaved[id];
      if (k != null) {
        d.setKeylock(k);
        this.emit({ kind: "toggle", deck: id, param: "keylock", value: k });
      }
    }
    if (announce) for (const d of ["A", "B"] as DeckId[]) this.emit({ kind: "board", deck: d, id: "smartFader", arg: "disarm" });
    this.armed = false;
    this.locked = false;
    this.stale = false;
    this.fromId = this.toId = null;
  }

  // A beat-matched throw: PIN key-lock off so the tempo morph pitches the decks (turntable-style)
  // and a KEY nudge adds to the glide instead of re-engaging key-lock; and tell SYNC the master's
  // tempo is COMMANDED (drop the grid-rubato feed-forward that fought the morph). Re-asserted on
  // every locked move, not just at arm: AUTO's own glide clears both when its transition ends or a
  // grab hands it to the hand, which left a smart throw that took over from AUTO un-pinned.
  private pin(): void {
    this.engine.deck("A").setKeylockPinnedOff(true);
    this.engine.deck("B").setKeylockPinnedOff(true);
    this.engine.setCommandedRamp(true);
    this.pinned = true;
  }
  private unpin(): void {
    if (!this.pinned) return;
    this.engine.setCommandedRamp(false); // back to normal beatmatch sync (feed-forward re-acquires)
    this.engine.deck("A").setKeylockPinnedOff(false);
    this.engine.deck("B").setKeylockPinnedOff(false);
    for (const id of ["A", "B"] as DeckId[]) {
      const k = this.keylockSaved[id];
      if (k != null) this.engine.deck(id).setKeylock(k);
    }
    this.pinned = false;
  }

  /** Drive the transition from a crossfade position `cf` (−1..+1). Call from the crossfader handler
   *  whenever Smart Fader is armed (instead of the plain setCrossfade). */
  onCrossfade(cf: number): void {
    if (!this.armed) {
      this.engine.setCrossfade(cf);
      return;
    }
    if (this.stale) {
      // Taking over from wherever the decks really are (AUTO mid-blend, or after it finished).
      this.stale = false;
      this.setupDirection(cf);
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

    this.fromId = from;
    this.toId = to;
    // ★ ONLY A PAIR THAT CAN BE BEAT-MATCHED IS BEAT-MATCHED (analysis tempoLockable). Otherwise the
    // throw is still a smart one — the bass swap, the incoming starting under the fader — but both
    // decks keep their own tempo and nothing is synced. Before, a pair with no grid made Smart Fader
    // refuse to arm at all, and a pair too far apart got a 25–40 % morph that sounded like neither.
    this.locked = tempoLockable(fromDeck.effectiveBpm ?? fromBase, toBpm) && !!fromBase;
    if (!this.locked) {
      this.unpin();
      if (this.engine.syncRole(to) === "slave") this.engine.toggleSync(to); // a previous throw's lock
      return true;
    }
    this.pin();
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
    if (this.locked) this.pin(); // idempotent; see pin()

    // Progress along the throw: 0 when the fader sits on `from`, 1 when it reaches `to`.
    const p = clamp01(from === "A" ? (cf + 1) / 2 : (1 - cf) / 2);
    this.lastProgress = p;

    const fromDeck = this.engine.deck(from);
    const toDeck = this.engine.deck(to);

    // The throw is bringing the incoming in (and it's a user fader move, not the arm) → start it
    // rolling under the fader. Deferred to here so arming during pause stays silent.
    if (started && p > 0.001 && !toDeck.playing) {
      toDeck.play();
      this.emit({ kind: "transport", deck: to, action: "play" });
    }

    // Tempo morph: move ONLY the master (live) tempo; the SYNC slave (incoming) follows
    // automatically (half/double folded for big gaps). Common BPM migrates fromStart → incoming.
    //
    // Re-read the incoming's natural BPM and fold it LIVE every step — do NOT trust the value frozen
    // at arm. The incoming deck's beatgrid can change AFTER setupDirection: async analysis settling,
    // or the DJ loading a different track on the idle deck during the armed wait. A frozen target
    // then makes the morph chase a STALE tempo (trace-confirmed: toFold stuck at 98 while the grid
    // had become 128), so the decks end mismatched and the endpoint release snaps the incoming to its
    // real natural BPM — the audible jump. fromBaseBpm is re-read too (a refined master grid stays
    // exact). fromStartBpm stays frozen: it's the morph's START, and it's the deck being morphed.
    if (this.locked) {
      const incNatural = toDeck.beatgrid?.bpm || this.toBpm;
      const fromBase = fromDeck.beatgrid?.bpm || this.fromBaseBpm;
      const foldedTarget = foldTempoOctave(incNatural, this.fromStartBpm) ?? incNatural;
      const targetBpm = lerp(this.fromStartBpm, foldedTarget, p);
      const tempoPct = (targetBpm / fromBase - 1) * 100;
      trace("sf", { from, to, p: +p.toFixed(3), start: +this.fromStartBpm.toFixed(1), toFold: +foldedTarget.toFixed(1), tgt: +targetBpm.toFixed(1), pct: +tempoPct.toFixed(2), incBpm: +incNatural.toFixed(1), incEff: +(toDeck.effectiveBpm ?? 0).toFixed(1) });
      this.tempo(from, tempoPct);
    }

    // Bass swap across the middle of the throw.
    const s = clamp01((p - BASS_LO) / (BASS_HI - BASS_LO));
    this.eqLow(from, lerp(0, EQ_KILL, s));
    this.eqLow(to, lerp(EQ_KILL, 0, s));

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
      this.eqLow(from, 0);
      if (this.locked) this.tempo(to, 0);
      this.setupDirection(cf);
    }
  }
}
