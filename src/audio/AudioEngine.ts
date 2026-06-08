import type { Beatgrid } from "./analyze";
import { Deck } from "./Deck";
import { PITCH_WORKLET_SRC } from "./pitchWorklet";

/** Fractional position within the current beat, 0..1. */
function phaseFraction(pos: number, g: Beatgrid): number {
  const p = ((pos - g.firstBeat) / g.interval) % 1;
  return p < 0 ? p + 1 : p;
}

// Master audio graph:
//
//   Deck A.output --> xfadeA --\
//                                >--> master --> destination
//   Deck B.output --> xfadeB --/
//
// The crossfader uses an equal-power curve so the perceived loudness stays
// roughly constant across the sweep (no dip in the middle).

export class AudioEngine {
  readonly ctx: AudioContext;
  readonly deckA: Deck;
  readonly deckB: Deck;

  private readonly xfadeA: GainNode;
  private readonly xfadeB: GainNode;
  private readonly master: GainNode;

  constructor() {
    this.ctx = new AudioContext({ latencyHint: "interactive" });

    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);

    this.xfadeA = this.ctx.createGain();
    this.xfadeB = this.ctx.createGain();
    this.xfadeA.connect(this.master);
    this.xfadeB.connect(this.master);

    this.deckA = new Deck(this.ctx);
    this.deckB = new Deck(this.ctx);
    this.deckA.output.connect(this.xfadeA);
    this.deckB.output.connect(this.xfadeB);

    this.setCrossfade(0);
    void this.initKeylock();
  }

  // Load the pitch-shift worklet (Blob URL → bundler-agnostic) and give each
  // deck a key-lock node. If it fails, the decks just run vinyl-mode.
  private async initKeylock() {
    try {
      const url = URL.createObjectURL(
        new Blob([PITCH_WORKLET_SRC], { type: "application/javascript" }),
      );
      await this.ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      this.deckA.attachPitchNode(new AudioWorkletNode(this.ctx, "pitch-shift", { outputChannelCount: [2] }));
      this.deckB.attachPitchNode(new AudioWorkletNode(this.ctx, "pitch-shift", { outputChannelCount: [2] }));
    } catch (e) {
      console.warn("[htl] key-lock unavailable:", e);
    }
  }

  /** Browsers start the context suspended until a user gesture. */
  resume() {
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  deck(id: "A" | "B"): Deck {
    return id === "A" ? this.deckA : this.deckB;
  }

  /**
   * Beat-sync: match `id` to the other deck — set its tempo so the BPMs match,
   * then nudge its playhead so its beats line up with the other deck's.
   */
  sync(id: "A" | "B") {
    const me = this.deck(id);
    const other = this.deck(id === "A" ? "B" : "A");
    const mg = me.beatgrid;
    const og = other.beatgrid;
    if (!mg || !og || !me.buffer) return;

    // Tempo match to the other deck's *effective* BPM.
    const targetBpm = other.effectiveBpm ?? og.bpm;
    me.setTempo((targetBpm / mg.bpm - 1) * 100);

    // Phase align: put me at the same fractional beat position as the other.
    const oFrac = phaseFraction(other.position(), og);
    const mPos = me.position();
    const mBeatStart = mg.firstBeat + Math.floor((mPos - mg.firstBeat) / mg.interval) * mg.interval;
    me.seek(mBeatStart + oFrac * mg.interval);
  }

  /** position in [-1, 1]: -1 = full A, 0 = both, +1 = full B. */
  setCrossfade(position: number) {
    const x = (Math.max(-1, Math.min(1, position)) + 1) / 2; // -> [0,1]
    this.xfadeA.gain.value = Math.cos((x * Math.PI) / 2);
    this.xfadeB.gain.value = Math.cos(((1 - x) * Math.PI) / 2);
  }

  setMaster(gain: number) {
    this.master.gain.value = gain;
  }
}
